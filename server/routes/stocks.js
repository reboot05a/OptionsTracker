import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toCents, toDollars, stockToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validateStock } from '../utils/validation.js';

const router = Router();

// GET all stocks
router.get('/', async (req, res) => {
    try {
        const { accountId, status } = req.query;

        const conditions = [];
        const params = [];
        let paramIdx = 1;

        if (accountId) {
            conditions.push(`"accountId" = $${paramIdx++}`);
            params.push(Number(accountId));
        }

        if (status === 'open') {
            conditions.push('"soldDate" IS NULL');
        } else if (status === 'closed') {
            conditions.push('"soldDate" IS NOT NULL');
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT * FROM roa_stocks ${whereClause} ORDER BY "acquiredDate" DESC, id DESC`,
            params
        );

        apiResponse.success(res, result.rows.map(stockToApi));
    } catch (error) {
        console.error('Error fetching stocks:', error);
        apiResponse.error(res, 'Failed to fetch stocks');
    }
});

// GET single stock
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_stocks WHERE id = $1', [req.params.id]);
        const stock = result.rows[0];
        if (!stock) {
            return apiResponse.error(res, 'Stock not found', 404);
        }
        apiResponse.success(res, stockToApi(stock));
    } catch (error) {
        console.error('Error fetching stock:', error);
        apiResponse.error(res, 'Failed to fetch stock');
    }
});

// POST create stock
router.post('/', async (req, res) => {
    try {
        const validationErrors = validateStock(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const { accountId, ticker, shares, costBasis, acquiredDate, notes } = req.body;

        const insertResult = await pool.query(`
            INSERT INTO roa_stocks ("accountId", ticker, shares, "costBasis", "acquiredDate", notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [
            Number(accountId),
            ticker.toUpperCase(),
            Number(shares),
            toCents(costBasis),
            acquiredDate,
            notes || null,
        ]);

        const newId = insertResult.rows[0].id;
        const fetchResult = await pool.query('SELECT * FROM roa_stocks WHERE id = $1', [newId]);
        apiResponse.created(res, stockToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error creating stock:', error);
        apiResponse.error(res, 'Failed to create stock');
    }
});

// PUT update/sell stock (supports partial sells)
router.put('/:id', async (req, res) => {
    try {
        const currentResult = await pool.query('SELECT * FROM roa_stocks WHERE id = $1', [req.params.id]);
        const current = currentResult.rows[0];
        if (!current) {
            return apiResponse.error(res, 'Stock not found', 404);
        }

        const validationErrors = validateStock(req.body, true);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const soldDate  = req.body.soldDate !== undefined ? req.body.soldDate : current.soldDate;
        const salePrice = req.body.salePrice !== undefined
            ? (req.body.salePrice !== null ? toCents(req.body.salePrice) : null)
            : current.salePrice;
        const sharesToSell = req.body.sharesToSell !== undefined ? Number(req.body.sharesToSell) : null;

        // Partial sell: split the lot
        if (soldDate && salePrice !== null && sharesToSell && sharesToSell < current.shares) {
            if (sharesToSell < 1 || !Number.isInteger(sharesToSell)) {
                return apiResponse.error(res, 'sharesToSell must be a positive integer', 400);
            }

            const costBasisDollars = toDollars(current.costBasis);
            const salePriceDollars = toDollars(salePrice);
            const capitalGainLoss  = toCents((salePriceDollars - costBasisDollars) * sharesToSell);

            const client = await pool.connect();
            let soldId;
            try {
                await client.query('BEGIN');

                // Reduce shares on original lot
                await client.query(
                    'UPDATE roa_stocks SET shares = $1, "updatedAt" = NOW() WHERE id = $2',
                    [current.shares - sharesToSell, current.id]
                );

                // Create new sold record for the sold portion
                const insertResult = await client.query(`
                    INSERT INTO roa_stocks
                        ("accountId", ticker, shares, "costBasis", "acquiredDate",
                         "soldDate", "salePrice", "capitalGainLoss", notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING id
                `, [
                    current.accountId,
                    current.ticker,
                    sharesToSell,
                    current.costBasis,
                    current.acquiredDate,
                    soldDate,
                    salePrice,
                    capitalGainLoss,
                    current.notes,
                ]);

                soldId = insertResult.rows[0].id;
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }

            const soldResult = await pool.query('SELECT * FROM roa_stocks WHERE id = $1', [soldId]);
            return apiResponse.success(res, stockToApi(soldResult.rows[0]));
        }

        // Full sell or regular update
        const ticker       = req.body.ticker ? req.body.ticker.toUpperCase() : current.ticker;
        const shares       = req.body.shares !== undefined ? Number(req.body.shares) : current.shares;
        const costBasis    = req.body.costBasis !== undefined ? toCents(req.body.costBasis) : current.costBasis;
        const acquiredDate = req.body.acquiredDate ?? current.acquiredDate;
        const notes        = req.body.notes !== undefined ? req.body.notes : current.notes;

        let capitalGainLoss = current.capitalGainLoss;
        if (soldDate && salePrice !== null) {
            const costBasisDollars = toDollars(costBasis);
            const salePriceDollars = toDollars(salePrice);
            capitalGainLoss = toCents((salePriceDollars - costBasisDollars) * shares);
        }

        await pool.query(`
            UPDATE roa_stocks
            SET ticker = $1, shares = $2, "costBasis" = $3, "acquiredDate" = $4,
                "soldDate" = $5, "salePrice" = $6, "capitalGainLoss" = $7,
                notes = $8, "updatedAt" = NOW()
            WHERE id = $9
        `, [ticker, shares, costBasis, acquiredDate, soldDate, salePrice, capitalGainLoss, notes, req.params.id]);

        const fetchResult = await pool.query('SELECT * FROM roa_stocks WHERE id = $1', [req.params.id]);
        apiResponse.success(res, stockToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error updating stock:', error);
        apiResponse.error(res, 'Failed to update stock');
    }
});

// DELETE stock
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM roa_stocks WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) {
            return apiResponse.error(res, 'Stock not found', 404);
        }
        apiResponse.success(res, { deleted: true, id: parseInt(req.params.id) });
    } catch (error) {
        console.error('Error deleting stock:', error);
        apiResponse.error(res, 'Failed to delete stock');
    }
});

export default router;
