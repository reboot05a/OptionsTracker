import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toCents, toDollars, tradeToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validateTrade } from '../utils/validation.js';

const router = Router();

// Calculate commission for a trade based on account rate (async — needs DB lookup)
// legs: 1 for Open/Expired/Assigned, 2 for Closed/Rolled
const calculateCommission = async (accountId, quantity, status) => {
    if (!accountId) return 0;
    const result = await pool.query(
        'SELECT "commissionPerContract" FROM roa_accounts WHERE id = $1',
        [accountId]
    );
    const account = result.rows[0];
    if (!account || !account.commissionPerContract) return 0;
    const legs = (status === 'Closed' || status === 'Rolled') ? 2 : 1;
    return account.commissionPerContract * quantity * legs;
};

// POST roll trade (atomic: close original + create new) - MUST be before /:id
router.post('/roll', async (req, res) => {
    try {
        const { originalTradeId, closePrice, newTrade } = req.body;

        if (!originalTradeId || closePrice === undefined || !newTrade) {
            return apiResponse.error(res, 'Missing required fields: originalTradeId, closePrice, newTrade', 400);
        }

        const closePriceNum = Number(closePrice);
        if (isNaN(closePriceNum) || closePriceNum < 0) {
            return apiResponse.error(res, 'Validation failed', 400, ['closePrice must be a non-negative number']);
        }

        const validationErrors = validateTrade(newTrade, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const origResult = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [originalTradeId]);
        const original = origResult.rows[0];
        if (!original) {
            return apiResponse.error(res, 'Original trade not found', 404);
        }

        // Pre-calculate commissions before entering transaction
        const originalQty = original.quantity || 1;
        const originalCommission = await calculateCommission(original.accountId, originalQty, 'Rolled');

        const newQty    = newTrade.quantity || original.quantity;
        const newStatus = newTrade.status || 'Open';
        const newCommission = (newTrade.commission !== undefined && newTrade.commission !== null && newTrade.commission !== '')
            ? toCents(newTrade.commission)
            : await calculateCommission(original.accountId, newQty, newStatus);

        const client = await pool.connect();
        let newTradeId;
        try {
            await client.query('BEGIN');

            // Close original trade as Rolled
            await client.query(`
                UPDATE roa_trades
                SET "closePrice" = $1, "closedDate" = $2, status = 'Rolled', commission = $3, "updatedAt" = NOW()
                WHERE id = $4
            `, [toCents(closePrice), newTrade.openedDate, originalCommission, originalTradeId]);

            // Create new rolled trade (inherit accountId from original)
            const insertResult = await client.query(`
                INSERT INTO roa_trades
                    (ticker, type, strike, quantity, delta, iv, "entryPrice", "closePrice",
                     "openedDate", "expirationDate", "closedDate", status, "parentTradeId",
                     notes, "accountId", commission, score, "entryStockPrice")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                RETURNING id
            `, [
                original.ticker,
                newTrade.type || original.type,
                toCents(newTrade.strike),
                newQty,
                newTrade.delta || null,
                (newTrade.iv !== undefined && newTrade.iv !== null && newTrade.iv !== '') ? Number(newTrade.iv) : null,
                toCents(newTrade.entryPrice),
                toCents(newTrade.closePrice) || 0,
                newTrade.openedDate,
                newTrade.expirationDate,
                newTrade.closedDate || null,
                newStatus,
                originalTradeId,
                newTrade.notes || null,
                original.accountId,
                newCommission,
                (newTrade.score !== undefined && newTrade.score !== null && newTrade.score !== '') ? Number(newTrade.score) : null,
                (newTrade.entryStockPrice !== undefined && newTrade.entryStockPrice !== null && newTrade.entryStockPrice !== '') ? toCents(newTrade.entryStockPrice) : null,
            ]);

            newTradeId = insertResult.rows[0].id;
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        const createdResult = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [newTradeId]);
        apiResponse.created(res, tradeToApi(createdResult.rows[0]));
    } catch (error) {
        console.error('Error rolling trade:', error);
        apiResponse.error(res, 'Failed to roll trade');
    }
});

// POST bulk import trades - MUST be before /:id
router.post('/import', async (req, res) => {
    try {
        const { trades, accountId } = req.body;

        if (!Array.isArray(trades) || trades.length === 0) {
            return apiResponse.error(res, 'No trades provided', 400);
        }

        let imported = 0;
        let skipped = 0;
        const idMap = new Map(); // old ID → new ID
        const assignedTrades = []; // track assigned trades for position creation

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Insert trades in dependency order (parents before children)
            const remaining = [...trades];
            let lastCount = -1;

            while (remaining.length > 0 && remaining.length !== lastCount) {
                lastCount = remaining.length;
                for (let i = remaining.length - 1; i >= 0; i--) {
                    const trade = remaining[i];
                    const oldParentId = trade.parentTradeId ? Number(trade.parentTradeId) : null;

                    // Skip if parent hasn't been inserted yet
                    if (oldParentId && !idMap.has(oldParentId)) continue;

                    try {
                        const newParentId     = oldParentId ? (idMap.get(oldParentId) || null) : null;
                        const tradeAccountId  = trade.accountId || accountId || null;

                        // Skip duplicates
                        const dupResult = await client.query(`
                            SELECT id FROM roa_trades
                            WHERE ticker = $1 AND type = $2 AND strike = $3 AND quantity = $4
                              AND "entryPrice" = $5 AND "openedDate" = $6 AND "expirationDate" = $7
                              AND ("accountId" = $8 OR ("accountId" IS NULL AND $8 IS NULL))
                            LIMIT 1
                        `, [
                            trade.ticker?.toUpperCase(), trade.type, toCents(trade.strike),
                            trade.quantity || 1, toCents(trade.entryPrice),
                            trade.openedDate, trade.expirationDate,
                            tradeAccountId,
                        ]);

                        if (dupResult.rows.length > 0) {
                            if (trade.id) idMap.set(Number(trade.id), dupResult.rows[0].id);
                            skipped++;
                            remaining.splice(i, 1);
                            continue;
                        }

                        const tradeQty    = trade.quantity || 1;
                        const tradeStatus = trade.status || 'Open';
                        const tradeCommission = (trade.commission !== undefined && trade.commission !== null && trade.commission !== '')
                            ? toCents(trade.commission)
                            : await calculateCommission(tradeAccountId, tradeQty, tradeStatus);

                        const insertResult = await client.query(`
                            INSERT INTO roa_trades
                                (ticker, type, strike, quantity, delta, iv, "entryPrice", "closePrice",
                                 "openedDate", "expirationDate", "closedDate", status, "parentTradeId",
                                 notes, "accountId", commission, score, "entryStockPrice")
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                            RETURNING id
                        `, [
                            trade.ticker?.toUpperCase(),
                            trade.type,
                            toCents(trade.strike),
                            tradeQty,
                            trade.delta || null,
                            (trade.iv !== undefined && trade.iv !== null && trade.iv !== '') ? Number(trade.iv) : null,
                            toCents(trade.entryPrice),
                            toCents(trade.closePrice) || 0,
                            trade.openedDate,
                            trade.expirationDate,
                            trade.closedDate || null,
                            tradeStatus,
                            newParentId,
                            trade.notes || null,
                            tradeAccountId,
                            tradeCommission,
                            (trade.score !== undefined && trade.score !== null && trade.score !== '') ? Number(trade.score) : null,
                            (trade.entryStockPrice !== undefined && trade.entryStockPrice !== null && trade.entryStockPrice !== '') ? toCents(trade.entryStockPrice) : null,
                        ]);

                        const newId = insertResult.rows[0].id;
                        if (trade.id) idMap.set(Number(trade.id), newId);

                        if (trade.status === 'Assigned') {
                            assignedTrades.push({
                                id: newId,
                                ticker: trade.ticker?.toUpperCase(),
                                type: trade.type,
                                strike: Number(trade.strike),
                                entryPrice: Number(trade.entryPrice),
                                quantity: trade.quantity || 1,
                                closedDate: trade.closedDate,
                                accountId: tradeAccountId,
                            });
                        }
                        imported++;
                    } catch (e) {
                        console.error('Error importing trade:', e, trade);
                    }
                    remaining.splice(i, 1);
                }
            }

            // Create/close positions for assigned trades (wheel strategy)
            for (const trade of assignedTrades) {
                if (trade.type !== 'CSP' && trade.type !== 'CC') continue;
                const shares = trade.quantity * 100;
                const assignmentDate = trade.closedDate || new Date().toISOString().split('T')[0];

                if (trade.type === 'CSP') {
                    const adjustedCostBasis = trade.strike - trade.entryPrice;
                    await client.query(`
                        INSERT INTO roa_positions (ticker, shares, "costBasis", "acquiredDate", "acquiredFromTradeId", "accountId")
                        VALUES ($1, $2, $3, $4, $5, $6)
                    `, [trade.ticker, shares, toCents(adjustedCostBasis), assignmentDate, trade.id, trade.accountId]);

                } else if (trade.type === 'CC') {
                    const posParams = trade.accountId ? [trade.ticker, trade.accountId] : [trade.ticker];
                    const posQuery  = trade.accountId
                        ? 'SELECT * FROM roa_positions WHERE ticker = $1 AND "soldDate" IS NULL AND "accountId" = $2 ORDER BY "acquiredDate" ASC LIMIT 1'
                        : 'SELECT * FROM roa_positions WHERE ticker = $1 AND "soldDate" IS NULL ORDER BY "acquiredDate" ASC LIMIT 1';
                    const openPosResult = await client.query(posQuery, posParams);
                    const openPosition  = openPosResult.rows[0];

                    if (openPosition) {
                        const costBasisDollars = toDollars(openPosition.costBasis);
                        const capitalGainLoss  = (trade.strike - costBasisDollars) * openPosition.shares;
                        await client.query(`
                            UPDATE roa_positions
                            SET "soldDate" = $1, "salePrice" = $2, "soldViaTradeId" = $3,
                                "capitalGainLoss" = $4, "updatedAt" = NOW()
                            WHERE id = $5
                        `, [assignmentDate, toCents(trade.strike), trade.id, toCents(capitalGainLoss), openPosition.id]);
                    }
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        apiResponse.created(res, { imported, skipped, total: trades.length });
    } catch (error) {
        console.error('Error importing trades:', error);
        apiResponse.error(res, 'Failed to import trades');
    }
});

// GET all trades with pagination, filtering, and sorting
router.get('/', async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            status,
            ticker,
            accountId,
            sortBy = 'openedDate',
            sortDir = 'asc',
        } = req.query;

        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const offset   = (pageNum - 1) * limitNum;

        // Whitelisted sort columns — always quoted for camelCase safety
        const validSortColumns = ['openedDate', 'expirationDate', 'closedDate', 'ticker', 'strike',
                                   'status', 'entryPrice', 'closePrice', 'type', 'id'];
        const rawSortColumn  = validSortColumns.includes(sortBy) ? sortBy : 'openedDate';
        const sortDirection  = sortDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        // Quote camelCase columns; leave lowercase ones unquoted (both are safe)
        const sortColumn = `"${rawSortColumn}"`;

        // Build dynamic WHERE clause with $N placeholders
        const conditions = [];
        const params     = [];
        let   paramIdx   = 1;

        if (accountId) {
            conditions.push(`"accountId" = $${paramIdx++}`);
            params.push(Number(accountId));
        }

        if (status && status !== 'all') {
            if (status === 'open') {
                conditions.push(`status = $${paramIdx++}`);
                params.push('Open');
            } else if (status === 'closed') {
                // Literal IN — no param needed
                conditions.push(`status IN ('Expired', 'Assigned', 'Closed', 'Rolled')`);
            } else {
                conditions.push(`status = $${paramIdx++}`);
                params.push(status);
            }
        }

        if (ticker) {
            conditions.push(`ticker = $${paramIdx++}`);
            params.push(ticker.toUpperCase());
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Count query uses the same params
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM roa_trades ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total);

        // Paginated data — LIMIT and OFFSET appended as next params
        const dataParams = [...params, limitNum, offset];
        const dataResult = await pool.query(`
            SELECT * FROM roa_trades
            ${whereClause}
            ORDER BY ${sortColumn} ${sortDirection}, id ASC
            LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `, dataParams);

        const totalPages = Math.ceil(total / limitNum);

        apiResponse.success(res, dataResult.rows.map(tradeToApi), {
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages,
                hasNext: pageNum < totalPages,
                hasPrev: pageNum > 1,
            },
        });
    } catch (error) {
        console.error('Error fetching trades:', error);
        apiResponse.error(res, 'Failed to fetch trades');
    }
});

// GET single trade
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [req.params.id]);
        const trade = result.rows[0];
        if (!trade) {
            return apiResponse.error(res, 'Trade not found', 404);
        }
        apiResponse.success(res, tradeToApi(trade));
    } catch (error) {
        console.error('Error fetching trade:', error);
        apiResponse.error(res, 'Failed to fetch trade');
    }
});

// POST create new trade
router.post('/', async (req, res) => {
    try {
        const {
            ticker, type, strike, quantity, delta, iv,
            entryPrice, closePrice, openedDate, expirationDate,
            closedDate, status, parentTradeId, notes, accountId,
            commission, score, entryStockPrice,
        } = req.body;

        const validationErrors = validateTrade(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const tickerUpper = ticker.toUpperCase();
        let resolvedParentTradeId = parentTradeId || null;

        // Auto-link CC to assigned CSP (wheel strategy only)
        if (type === 'CC' && !parentTradeId) {
            const posQuery  = accountId
                ? `SELECT "acquiredFromTradeId" FROM roa_positions
                   WHERE ticker = $1 AND "soldDate" IS NULL AND "acquiredFromTradeId" IS NOT NULL AND "accountId" = $2
                   ORDER BY "acquiredDate" ASC LIMIT 1`
                : `SELECT "acquiredFromTradeId" FROM roa_positions
                   WHERE ticker = $1 AND "soldDate" IS NULL AND "acquiredFromTradeId" IS NOT NULL
                   ORDER BY "acquiredDate" ASC LIMIT 1`;
            const posParams = accountId ? [tickerUpper, Number(accountId)] : [tickerUpper];
            const posResult = await pool.query(posQuery, posParams);
            const openPos   = posResult.rows[0];

            if (openPos && openPos.acquiredFromTradeId) {
                resolvedParentTradeId = openPos.acquiredFromTradeId;
                console.log(`🔗 Auto-linking CC to CSP trade #${resolvedParentTradeId} for ${tickerUpper}`);
            }
        }

        const tradeQty    = quantity || 1;
        const tradeStatus = status || 'Open';
        const commissionCents = (commission !== undefined && commission !== null && commission !== '')
            ? toCents(commission)
            : await calculateCommission(accountId, tradeQty, tradeStatus);

        const insertResult = await pool.query(`
            INSERT INTO roa_trades
                (ticker, type, strike, quantity, delta, iv, "entryPrice", "closePrice",
                 "openedDate", "expirationDate", "closedDate", status, "parentTradeId",
                 notes, "accountId", commission, score, "entryStockPrice")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            RETURNING id
        `, [
            tickerUpper,
            type,
            toCents(strike),
            tradeQty,
            delta || null,
            (iv !== undefined && iv !== null && iv !== '') ? Number(iv) : null,
            toCents(entryPrice),
            toCents(closePrice) || 0,
            openedDate,
            expirationDate,
            closedDate || null,
            tradeStatus,
            resolvedParentTradeId,
            notes || null,
            accountId || null,
            commissionCents,
            (score !== undefined && score !== null && score !== '') ? Number(score) : null,
            (entryStockPrice !== undefined && entryStockPrice !== null && entryStockPrice !== '') ? toCents(entryStockPrice) : null,
        ]);

        const newId     = insertResult.rows[0].id;
        const fetchResult = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [newId]);
        apiResponse.created(res, tradeToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error creating trade:', error);
        apiResponse.error(res, 'Failed to create trade');
    }
});

// PUT update trade
router.put('/:id', async (req, res) => {
    try {
        const currentResult = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [req.params.id]);
        const currentTrade  = currentResult.rows[0];
        if (!currentTrade) {
            return apiResponse.error(res, 'Trade not found', 404);
        }

        const validationErrors = validateTrade(req.body, true);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        // Use request body values (dollars) or fall back to current trade values (convert from cents)
        const ticker         = req.body.ticker        ?? currentTrade.ticker;
        const type           = req.body.type          ?? currentTrade.type;
        const strike         = req.body.strike        ?? toDollars(currentTrade.strike);
        const quantity       = req.body.quantity      ?? currentTrade.quantity;
        const delta          = req.body.delta         ?? currentTrade.delta;
        const iv             = req.body.iv !== undefined
            ? (req.body.iv !== null && req.body.iv !== '' ? Number(req.body.iv) : null)
            : currentTrade.iv;
        const entryStockPrice = req.body.entryStockPrice !== undefined
            ? (req.body.entryStockPrice !== null && req.body.entryStockPrice !== '' ? toCents(Number(req.body.entryStockPrice)) : null)
            : currentTrade.entryStockPrice;
        const entryPrice     = req.body.entryPrice    ?? toDollars(currentTrade.entryPrice);
        const closePrice     = req.body.closePrice    ?? toDollars(currentTrade.closePrice);
        const openedDate     = req.body.openedDate    ?? currentTrade.openedDate;
        const expirationDate = req.body.expirationDate ?? currentTrade.expirationDate;
        const closedDate     = req.body.closedDate    ?? currentTrade.closedDate;
        const status         = req.body.status        ?? currentTrade.status;
        const parentTradeId  = req.body.parentTradeId ?? currentTrade.parentTradeId;
        const notes          = req.body.notes         ?? currentTrade.notes;
        const score          = req.body.score !== undefined
            ? (req.body.score !== null && req.body.score !== '' ? Number(req.body.score) : null)
            : currentTrade.score;

        let commissionCents;
        if (req.body.commission !== undefined && req.body.commission !== null && req.body.commission !== '') {
            commissionCents = toCents(req.body.commission);
        } else {
            commissionCents = await calculateCommission(currentTrade.accountId, quantity || 1, status);
        }

        const updateResult = await pool.query(`
            UPDATE roa_trades
            SET ticker = $1, type = $2, strike = $3, quantity = $4, delta = $5, iv = $6,
                "entryPrice" = $7, "closePrice" = $8, "openedDate" = $9, "expirationDate" = $10,
                "closedDate" = $11, status = $12, "parentTradeId" = $13, notes = $14,
                commission = $15, score = $16, "entryStockPrice" = $17, "updatedAt" = NOW()
            WHERE id = $18
        `, [
            ticker.toUpperCase(),
            type,
            toCents(strike),
            quantity || 1,
            delta || null,
            iv,
            toCents(entryPrice),
            toCents(closePrice) || 0,
            openedDate,
            expirationDate,
            closedDate || null,
            status || 'Open',
            parentTradeId || null,
            notes || null,
            commissionCents,
            score,
            entryStockPrice,
            req.params.id,
        ]);

        if (updateResult.rowCount === 0) {
            return apiResponse.error(res, 'Trade not found', 404);
        }

        const updatedResult  = await pool.query('SELECT * FROM roa_trades WHERE id = $1', [req.params.id]);
        const updatedTradeApi = tradeToApi(updatedResult.rows[0]);

        // Handle position creation/closing on assignment (wheel strategy only)
        if (status === 'Assigned' && currentTrade.status !== 'Assigned' && (type === 'CSP' || type === 'CC')) {
            const tickerUpper    = ticker.toUpperCase();
            const shares         = (quantity || 1) * 100;
            const assignmentDate = closedDate || new Date().toISOString().split('T')[0];

            if (type === 'CSP') {
                const adjustedCostBasis = strike - entryPrice; // dollars
                await pool.query(`
                    INSERT INTO roa_positions (ticker, shares, "costBasis", "acquiredDate", "acquiredFromTradeId", "accountId")
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [tickerUpper, shares, toCents(adjustedCostBasis), assignmentDate, req.params.id, currentTrade.accountId]);
                console.log(`📈 Position created: ${shares} shares of ${tickerUpper} at $${adjustedCostBasis.toFixed(2)}`);

            } else if (type === 'CC') {
                const ccPosQuery  = currentTrade.accountId
                    ? 'SELECT * FROM roa_positions WHERE ticker = $1 AND "soldDate" IS NULL AND "accountId" = $2 ORDER BY "acquiredDate" ASC LIMIT 1'
                    : 'SELECT * FROM roa_positions WHERE ticker = $1 AND "soldDate" IS NULL ORDER BY "acquiredDate" ASC LIMIT 1';
                const ccPosParams = currentTrade.accountId ? [tickerUpper, currentTrade.accountId] : [tickerUpper];
                const ccPosResult = await pool.query(ccPosQuery, ccPosParams);
                const openPosition = ccPosResult.rows[0];

                if (openPosition) {
                    const costBasisDollars = toDollars(openPosition.costBasis);
                    const capitalGainLoss  = (strike - costBasisDollars) * openPosition.shares;
                    await pool.query(`
                        UPDATE roa_positions
                        SET "soldDate" = $1, "salePrice" = $2, "soldViaTradeId" = $3,
                            "capitalGainLoss" = $4, "updatedAt" = NOW()
                        WHERE id = $5
                    `, [assignmentDate, toCents(strike), req.params.id, toCents(capitalGainLoss), openPosition.id]);
                    console.log(`📉 Position closed: ${openPosition.shares} shares of ${tickerUpper} at $${strike} (G/L: $${capitalGainLoss})`);
                }
            }
        }

        apiResponse.success(res, updatedTradeApi);
    } catch (error) {
        console.error('Error updating trade:', error);
        apiResponse.error(res, 'Failed to update trade');
    }
});

// DELETE trade (wrapped in transaction — multiple tables affected)
router.delete('/:id', async (req, res) => {
    try {
        const tradeId = req.params.id;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Unlink child trades
            await client.query(
                'UPDATE roa_trades SET "parentTradeId" = NULL WHERE "parentTradeId" = $1',
                [tradeId]
            );

            // Delete positions created by this trade (CSP assignment)
            const delPos = await client.query(
                'DELETE FROM roa_positions WHERE "acquiredFromTradeId" = $1',
                [tradeId]
            );
            if (delPos.rowCount > 0) {
                console.log(`🗑️ Deleted ${delPos.rowCount} position(s) created by trade ${tradeId}`);
            }

            // Reset positions sold via this trade (CC assignment) — make them open again
            const resetPos = await client.query(`
                UPDATE roa_positions
                SET "soldDate" = NULL, "salePrice" = NULL, "soldViaTradeId" = NULL,
                    "capitalGainLoss" = NULL, "updatedAt" = NOW()
                WHERE "soldViaTradeId" = $1
            `, [tradeId]);
            if (resetPos.rowCount > 0) {
                console.log(`↩️ Reset ${resetPos.rowCount} position(s) sold via trade ${tradeId}`);
            }

            // Delete the trade itself
            const delTrade = await client.query('DELETE FROM roa_trades WHERE id = $1', [tradeId]);
            if (delTrade.rowCount === 0) {
                await client.query('ROLLBACK');
                return apiResponse.error(res, 'Trade not found', 404);
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        apiResponse.success(res, { deleted: true, id: parseInt(tradeId) });
    } catch (error) {
        console.error('Error deleting trade:', error);
        apiResponse.error(res, 'Failed to delete trade');
    }
});

export default router;
