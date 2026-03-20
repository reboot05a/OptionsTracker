import { Router } from 'express';
import { db } from '../db/connection.js';
import { toCents, toDollars, positionToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validatePosition } from '../utils/validation.js';

const router = Router();

// GET positions summary (realized + unrealized gains) - MUST be before :id route
router.get('/summary', (req, res) => {
    try {
        const { accountId } = req.query;
        const acctFilter = accountId ? 'AND accountId = ?' : '';
        const acctParams = accountId ? [Number(accountId)] : [];

        // Realized gains from closed positions
        const realizedStats = db.prepare(`
            SELECT
                COALESCE(SUM(capitalGainLoss), 0) as realizedGainLoss,
                COUNT(*) as closedPositions
            FROM positions
            WHERE soldDate IS NOT NULL ${acctFilter}
        `).get(...acctParams);

        // Open positions for unrealized calculation
        const openPositions = db.prepare(`
            SELECT * FROM positions WHERE soldDate IS NULL ${acctFilter}
        `).all(...acctParams);

        apiResponse.success(res, {
            realizedGainLoss: toDollars(realizedStats.realizedGainLoss),
            closedPositions: realizedStats.closedPositions,
            openPositions: openPositions.length,
            openPositionsList: openPositions.map(positionToApi)
        });
    } catch (error) {
        console.error('Error fetching positions summary:', error);
        apiResponse.error(res, 'Failed to fetch positions summary');
    }
});

// GET all positions
router.get('/', (req, res) => {
    try {
        const { status, accountId } = req.query;

        const conditions = [];
        const params = [];

        if (accountId) {
            conditions.push('accountId = ?');
            params.push(Number(accountId));
        }

        if (status === 'open') {
            conditions.push('soldDate IS NULL');
        } else if (status === 'closed') {
            conditions.push('soldDate IS NOT NULL');
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `SELECT * FROM positions ${whereClause} ORDER BY acquiredDate DESC`;

        const positions = db.prepare(query).all(...params);
        apiResponse.success(res, positions.map(positionToApi));
    } catch (error) {
        console.error('Error fetching positions:', error);
        apiResponse.error(res, 'Failed to fetch positions');
    }
});

// GET single position
router.get('/:id', (req, res) => {
    try {
        const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
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
router.post('/', (req, res) => {
    try {
        const { ticker, shares, costBasis, acquiredDate, acquiredFromTradeId, accountId } = req.body;

        // Validate input
        const validationErrors = validatePosition(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const stmt = db.prepare(`
            INSERT INTO positions (ticker, shares, costBasis, acquiredDate, acquiredFromTradeId, accountId)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            ticker.toUpperCase(),
            shares,
            toCents(costBasis),
            acquiredDate,
            acquiredFromTradeId || null,
            accountId || null
        );

        const newPosition = db.prepare('SELECT * FROM positions WHERE id = ?').get(result.lastInsertRowid);
        apiResponse.created(res, positionToApi(newPosition));
    } catch (error) {
        console.error('Error creating position:', error);
        apiResponse.error(res, 'Failed to create position');
    }
});

// PUT update/close/reopen position (supports partial sells and reopen)
router.put('/:id', (req, res) => {
    try {
        const { soldDate, salePrice, soldViaTradeId, reopen } = req.body;

        const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
        if (!position) {
            return apiResponse.error(res, 'Position not found', 404);
        }

        // Reopen a closed position: clear sold fields
        if (reopen) {
            if (!position.soldDate) {
                return apiResponse.error(res, 'Position is already open', 400);
            }

            db.prepare(`
                UPDATE positions
                SET soldDate = NULL, salePrice = NULL, soldViaTradeId = NULL, capitalGainLoss = NULL, updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.id);

            const reopened = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
            return apiResponse.success(res, positionToApi(reopened));
        }

        // Validate input
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

            const partialSellTx = db.transaction(() => {
                // Reduce shares on original position
                db.prepare(`
                    UPDATE positions SET shares = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
                `).run(position.shares - sharesToSell, position.id);

                // Create new closed position for the sold portion
                const result = db.prepare(`
                    INSERT INTO positions (ticker, shares, costBasis, acquiredDate, acquiredFromTradeId, accountId, soldDate, salePrice, soldViaTradeId, capitalGainLoss)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    position.ticker,
                    sharesToSell,
                    position.costBasis,
                    position.acquiredDate,
                    position.acquiredFromTradeId,
                    position.accountId,
                    soldDate,
                    toCents(salePrice),
                    soldViaTradeId || null,
                    toCents(capitalGainLoss)
                );

                return result.lastInsertRowid;
            });

            const soldId = partialSellTx();
            const soldPosition = db.prepare('SELECT * FROM positions WHERE id = ?').get(soldId);
            return apiResponse.success(res, positionToApi(soldPosition));
        }

        // Full sell: update in place
        const costBasisDollars = toDollars(position.costBasis);
        const capitalGainLoss = (salePrice - costBasisDollars) * position.shares;

        const stmt = db.prepare(`
            UPDATE positions
            SET soldDate = ?, salePrice = ?, soldViaTradeId = ?, capitalGainLoss = ?, updatedAt = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        stmt.run(soldDate, toCents(salePrice), soldViaTradeId || null, toCents(capitalGainLoss), req.params.id);

        const updatedPosition = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
        apiResponse.success(res, positionToApi(updatedPosition));
    } catch (error) {
        console.error('Error updating position:', error);
        apiResponse.error(res, 'Failed to update position');
    }
});

// DELETE position
router.delete('/:id', (req, res) => {
    try {
        const result = db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
        if (result.changes === 0) {
            return apiResponse.error(res, 'Position not found', 404);
        }
        apiResponse.success(res, { deleted: true, id: parseInt(req.params.id) });
    } catch (error) {
        console.error('Error deleting position:', error);
        apiResponse.error(res, 'Failed to delete position');
    }
});

export default router;
