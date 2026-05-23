import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toDollars } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// GET stats/summary - Using SQL aggregations for performance
router.get('/', async (req, res) => {
    try {
        const { accountId } = req.query;
        // Each query uses $1 for accountId (always the only param in these queries)
        const acctWhere  = accountId ? 'WHERE "accountId" = $1' : '';
        const acctAnd    = accountId ? 'AND "accountId" = $1' : '';
        const acctParams = accountId ? [Number(accountId)] : [];

        // Run all queries in parallel
        const [mainResult, chainResult, chainPnLResult, monthlyResult,
               tickerResult, avgRoiResult, positionResult] = await Promise.all([

            // Main stats — single aggregation over all trades
            pool.query(`
                SELECT
                    COUNT(*)                                                  AS "totalTrades",
                    COUNT(CASE WHEN status = 'Open'     THEN 1 END)          AS "openCount",
                    COUNT(CASE WHEN status = 'Expired'  THEN 1 END)          AS "expiredCount",
                    COUNT(CASE WHEN status = 'Assigned' THEN 1 END)          AS "assignedCount",
                    COUNT(CASE WHEN status = 'Rolled'   THEN 1 END)          AS "rolledCount",
                    COUNT(CASE WHEN status = 'Closed'   THEN 1 END)          AS "closedCount",
                    COALESCE(SUM(
                        CASE WHEN type IN ('CSP', 'CC')
                             THEN ("entryPrice" - "closePrice") * quantity * 100 - commission
                             WHEN type IN ('CALL', 'PUT')
                             THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                             ELSE 0 END), 0)                                 AS "totalPnL",
                    COALESCE(SUM("entryPrice" * quantity * 100), 0)          AS "totalPremium",
                    COALESCE(SUM(
                        CASE WHEN status = 'Open' AND type IN ('CSP', 'CC')
                             THEN strike * quantity * 100
                             WHEN status = 'Open' AND type IN ('CALL', 'PUT')
                             THEN "entryPrice" * quantity * 100
                             ELSE 0 END), 0)                                 AS "capitalAtRisk",
                    COALESCE(SUM(commission), 0)                             AS "totalCommissions"
                FROM roa_trades
                ${acctWhere}
            `, acctParams),

            // Chain statistics — count roots and resolved chains
            pool.query(`
                SELECT
                    COUNT(*) AS "totalChains",
                    COUNT(CASE WHEN status NOT IN ('Open', 'Rolled') THEN 1 END) AS "resolvedChains"
                FROM roa_trades
                WHERE "parentTradeId" IS NULL ${acctAnd}
            `, acctParams),

            // Chain P/L using recursive CTE — works unchanged in Postgres
            // Account filter on base case only; children follow via parentTradeId
            pool.query(`
                WITH RECURSIVE chain_walk AS (
                    -- Base: root trades (no parent)
                    SELECT
                        id AS root_id,
                        id AS current_id,
                        CASE WHEN type IN ('CALL', 'PUT')
                             THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                             ELSE ("entryPrice" - "closePrice") * quantity * 100 - commission
                        END AS chain_pnl,
                        status AS final_status
                    FROM roa_trades
                    WHERE "parentTradeId" IS NULL ${acctAnd}

                    UNION ALL

                    -- Recursive: follow children
                    SELECT
                        cw.root_id,
                        t.id AS current_id,
                        cw.chain_pnl + CASE WHEN t.type IN ('CALL', 'PUT')
                            THEN (t."closePrice" - t."entryPrice") * t.quantity * 100 - t.commission
                            ELSE (t."entryPrice" - t."closePrice") * t.quantity * 100 - t.commission
                        END,
                        t.status AS final_status
                    FROM chain_walk cw
                    JOIN roa_trades t ON t."parentTradeId" = cw.current_id
                ),
                -- Final state of each chain (leaf node)
                chain_finals AS (
                    SELECT root_id, chain_pnl, final_status
                    FROM chain_walk cw
                    WHERE NOT EXISTS (
                        SELECT 1 FROM roa_trades t WHERE t."parentTradeId" = cw.current_id
                    )
                )
                SELECT
                    COUNT(CASE WHEN final_status NOT IN ('Open', 'Rolled') AND chain_pnl > 0 THEN 1 END) AS winning_chains,
                    COUNT(CASE WHEN final_status NOT IN ('Open', 'Rolled') THEN 1 END)                   AS resolved_chains
                FROM chain_finals
            `, acctParams),

            // Monthly P/L — strftime → TO_CHAR
            pool.query(`
                SELECT
                    TO_CHAR(COALESCE("closedDate", "openedDate")::date, 'YYYY-MM') AS month,
                    SUM(CASE WHEN type IN ('CALL', 'PUT')
                             THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                             ELSE ("entryPrice" - "closePrice") * quantity * 100 - commission
                        END) AS pnl
                FROM roa_trades
                WHERE status NOT IN ('Open', 'Rolled') ${acctAnd}
                GROUP BY month
                ORDER BY month DESC
            `, acctParams),

            // Ticker P/L
            pool.query(`
                SELECT
                    ticker,
                    SUM(CASE WHEN type IN ('CALL', 'PUT')
                             THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                             ELSE ("entryPrice" - "closePrice") * quantity * 100 - commission
                        END) AS pnl
                FROM roa_trades
                ${acctWhere}
                GROUP BY ticker
                ORDER BY pnl DESC
            `, acctParams),

            // Average ROI for completed trades
            pool.query(`
                SELECT AVG(
                    CASE WHEN strike > 0 AND quantity > 0 AND type IN ('CSP', 'CC')
                    THEN (("entryPrice" - "closePrice") * 100.0 - commission * 1.0 / quantity) / strike
                    WHEN quantity > 0 AND "entryPrice" > 0 AND type IN ('CALL', 'PUT')
                    THEN (("closePrice" - "entryPrice") * 100.0 - commission * 1.0 / quantity) / "entryPrice"
                    ELSE 0 END
                ) AS "avgRoi"
                FROM roa_trades
                WHERE status NOT IN ('Open', 'Rolled') ${acctAnd}
            `, acctParams),

            // Capital gains from positions
            pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN "soldDate" IS NOT NULL THEN "capitalGainLoss" ELSE 0 END), 0) AS "realizedCapitalGL",
                    COUNT(CASE WHEN "soldDate" IS NOT NULL THEN 1 END) AS "closedPositions",
                    COUNT(CASE WHEN "soldDate" IS NULL     THEN 1 END) AS "openPositions"
                FROM roa_positions
                ${acctWhere}
            `, acctParams),
        ]);

        const mainStats    = mainResult.rows[0];
        const chainStats   = chainResult.rows[0];
        const chainPnL     = chainPnLResult.rows[0];
        const monthlyRows  = monthlyResult.rows;
        const tickerRows   = tickerResult.rows;
        const posStats     = positionResult.rows[0];

        const winningChains = parseInt(chainPnL.winning_chains) || 0;
        const resolvedCount = parseInt(chainPnL.resolved_chains) || 0;
        const winRate = resolvedCount > 0 ? (winningChains / resolvedCount) * 100 : 0;

        const bestTicker = tickerRows.length > 0 ? tickerRows[0] : null;

        // pg returns integer aggregates as strings — parseInt all counts/sums
        const totalPnL          = parseInt(mainStats.totalPnL);
        const realizedCapitalGL = parseInt(posStats.realizedCapitalGL);

        apiResponse.success(res, {
            totalPnL:               toDollars(totalPnL),
            totalPremiumCollected:  toDollars(parseInt(mainStats.totalPremium)),
            totalTrades:            parseInt(mainStats.totalTrades),
            openTradesCount:        parseInt(mainStats.openCount),
            completedTradesCount:   parseInt(mainStats.expiredCount) + parseInt(mainStats.assignedCount) + parseInt(mainStats.closedCount),
            capitalAtRisk:          toDollars(parseInt(mainStats.capitalAtRisk)),
            winningChains,
            totalChains:            parseInt(chainStats.totalChains),
            resolvedChains:         resolvedCount,
            winRate,
            avgRoi:                 avgRoiResult.rows[0].avgRoi || 0,
            totalAssigned:          parseInt(mainStats.assignedCount),
            totalExpired:           parseInt(mainStats.expiredCount),
            totalRolled:            parseInt(mainStats.rolledCount),
            monthlyStats:           Object.fromEntries(monthlyRows.map(m => [m.month, toDollars(parseInt(m.pnl))])),
            tickerStats:            Object.fromEntries(tickerRows.map(t => [t.ticker, toDollars(parseInt(t.pnl))])),
            bestTicker:             bestTicker ? { ...bestTicker, pnl: toDollars(parseInt(bestTicker.pnl)) } : null,
            realizedCapitalGL:      toDollars(realizedCapitalGL),
            openPositions:          parseInt(posStats.openPositions),
            closedPositions:        parseInt(posStats.closedPositions),
            totalPnLWithCapitalGains: toDollars(totalPnL + realizedCapitalGL),
            totalCommissions:       toDollars(parseInt(mainStats.totalCommissions)),
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        apiResponse.error(res, 'Failed to fetch stats');
    }
});

export default router;
