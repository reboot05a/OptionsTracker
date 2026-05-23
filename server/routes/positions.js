import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toCents, toDollars, positionToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validatePosition } from '../utils/validation.js';

const router = Router();

// GET positions summary (realized + unrealized gains) - MUST be before :id route
router.get('/summary', async (req, res) => {
    try {
        const { accountId } = req.query;

        const conditions = ['soldDate IS NOT NULL'];
        const openConditions = ['soldDate IS NULL'];
        const params = [];
        let paramIdx = 1;

        if (accountId) {
            conditions.push(`"accountId" = $${paramIdx}`);
            openConditions.push(`"accountId" = $${paramIdx}`);
            params.push(Number(accountId));
            paramIdx++;
        }

        const [realizedResult, openResult] = await Promise.all([
            pool.query(`
                SELECT
                    COALESCE(SUM("capitalGainLoss"), 0) AS "realizedGainLoss",
                    COUNT(*) AS "closedPositions"
                FROM roa_positions
                WHERE ${conditions.join(' AND ')}
            `, params),
            pool.query(`
                SELECT * FROM roa_positions
                WHERE ${openConditions.join(' AND ')}
            `, params),
        ]);

        const stats = realizedResult.rows[0];
        const openPositions = openResult.rows;

        apiResponse.success(res, {
            realizedGainLoss: toDollars(parseInt(stats.realizedGainLoss)),
            closedPositions: parseInt(stats.closedPositions),
            openPositions: openPositions.length,
            openPositionsList: openPositions.map(positionToApi)
        });
    } catch (error) {
        console.error('Error fetching positions summary:', error);
        apiResponse.error(res, 'Failed to fetch positions summary');
    }
});

// GET all positions
router.get('/', async (req, res) => {
    try {
        const { status, accountId } = req.query;

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
            `SELECT * FROM roa_positions ${whereClause} ORDER BY "acquiredDate" DESC`,
            params
        );

        apiResponse.success(res, result.rows.map(positionToApi));
    } catch (error) {
        console.error('Error fetching positions:', error);
        apiResponse.error(res, 'Failed to fetch positions');
    }
});

// GET single position
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [req.params.id]);
        const position = result.rows[0];
        if (!position) {
            return apiResponse.error(res, 'Position not found', 404);
        }
        apiResponse.success(res, positionToApi(position));
    } catch (error) {
        console.error('Error fetching position:', error);
        apiResponse.error(res, 'Failed to fetch position');
    }
});

// POST create position (manual entry or from assignment)
router.post('/', async (req, res) => {
    try {
        const { ticker, shares, costBasis, acquiredDate, acquiredFromTradeId, accountId } = req.body;

        const validationErrors = validatePosition(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const insertResult = await pool.query(`
            INSERT INTO roa_positions (ticker, shares, "costBasis", "acquiredDate", "acquiredFromTradeId", "accountId")
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [
            ticker.toUpperCase(),
            shares,
            toCents(costBasis),
            acquiredDate,
            acquiredFromTradeId || null,
            accountId || null,
        ]);

        const newId = insertResult.rows[0].id;
        const fetchResult = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [newId]);
        apiResponse.created(res, positionToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error creating position:', error);
        apiResponse.error(res, 'Failed to create position');
    }
});

// PUT update/close/reopen position (supports partial sells and reopen)
router.put('/:id', async (req, res) => {
    try {
        const { soldDate, salePrice, soldViaTradeId, reopen } = req.body;

        const posResult = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [req.params.id]);
        const position = posResult.rows[0];
        if (!position) {
            return apiResponse.error(res, 'Position not found', 404);
        }

        // Reopen a closed position: clear sold fields
        if (reopen) {
            if (!position.soldDate) {
                return apiResponse.error(res, 'Position is already open', 400);
            }

            await pool.query(`
                UPDATE roa_positions
                SET "soldDate" = NULL, "salePrice" = NULL, "soldViaTradeId" = NULL,
                    "capitalGainLoss" = NULL, "updatedAt" = NOW()
                WHERE id = $1
            `, [req.params.id]);

            const reopenedResult = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [req.params.id]);
            return apiResponse.success(res, positionToApi(reopenedResult.rows[0]));
        }

        const validationErrors = validatePosition(req.body, true);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const sharesToSell = req.body.sharesToSell !== undefined ? Number(req.body.sharesToSell) : null;

        // Partial sell: split the lot
        if (soldDate && salePrice !== undefined && sharesToSell && sharesToSell < position.shares) {
            if (sharesToSell < 1 || !Number.isInteger(sharesToSell)) {
                return apiResponse.error(res, 'sharesToSell must be a positive integer', 400);
            }

            const costBasisDollars = toDollars(position.costBasis);
            const capitalGainLoss = (salePrice - costBasisDollars) * sharesToSell;

            const client = await pool.connect();
            let soldId;
            try {
                await client.query('BEGIN');

                // Reduce shares on original position
                await client.query(
                    'UPDATE roa_positions SET shares = $1, "updatedAt" = NOW() WHERE id = $2',
                    [position.shares - sharesToSell, position.id]
                );

                // Create new closed position for the sold portion
                const insertResult = await client.query(`
                    INSERT INTO roa_positions
                        (ticker, shares, "costBasis", "acquiredDate", "acquiredFromTradeId", "accountId",
                         "soldDate", "salePrice", "soldViaTradeId", "capitalGainLoss")
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING id
                `, [
                    position.ticker,
                    sharesToSell,
                    position.costBasis,
                    position.acquiredDate,
                    position.acquiredFromTradeId,
                    position.accountId,
                    soldDate,
                    toCents(salePrice),
                    soldViaTradeId || null,
                    toCents(capitalGainLoss),
                ]);

                soldId = insertResult.rows[0].id;
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }

            const soldResult = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [soldId]);
            return apiResponse.success(res, positionToApi(soldResult.rows[0]));
        }

        // Full sell: update in place
        const costBasisDollars = toDollars(position.costBasis);
        const capitalGainLoss = (salePrice - costBasisDollars) * position.shares;

        await pool.query(`
            UPDATE roa_positions
            SET "soldDate" = $1, "salePrice" = $2, "soldViaTradeId" = $3,
                "capitalGainLoss" = $4, "updatedAt" = NOW()
            WHERE id = $5
        `, [soldDate, toCents(salePrice), soldViaTradeId || null, toCents(capitalGainLoss), req.params.id]);

        const updatedResult = await pool.query('SELECT * FROM roa_positions WHERE id = $1', [req.params.id]);
        apiResponse.success(res, positionToApi(updatedResult.rows[0]));
    } catch (error) {
        console.error('Error updating position:', error);
        apiResponse.error(res, 'Failed to update position');
    }
});

// DELETE position
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM roa_positions WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) {
            return apiResponse.error(res, 'Position not found', 404);
        }
        apiResponse.success(res, { deleted: true, id: parseInt(req.params.id) });
    } catch (error) {
        console.error('Error deleting position:', error);
        apiResponse.error(res, 'Failed to delete position');
    }
});

export default router;
