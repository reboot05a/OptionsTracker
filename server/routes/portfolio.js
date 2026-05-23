import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toDollars } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// GET /api/portfolio/stats?accountId=X — Aggregate portfolio statistics
router.get('/stats', async (req, res) => {
    try {
        const { accountId } = req.query;
        // Each query uses $1 for accountId (it is always the only param in these queries)
        const acctWhere  = accountId ? 'WHERE "accountId" = $1' : '';
        const acctAnd    = accountId ? 'AND "accountId" = $1' : '';
        const acctParams = accountId ? [Number(accountId)] : [];

        // Run all aggregate queries in parallel
        const [fundResult, optionsResult, posGainsResult, stockGainsResult,
               closedTradesResult, closedStocksResult, closedPosResult] = await Promise.all([

            pool.query(`
                SELECT type, COALESCE(SUM(amount), 0) AS total
                FROM roa_fund_transactions
                ${acctWhere}
                GROUP BY type
            `, acctParams),

            pool.query(`
                SELECT COALESCE(SUM(
                    CASE WHEN type IN ('CALL', 'PUT')
                         THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                         ELSE ("entryPrice" - "closePrice") * quantity * 100 - commission
                    END), 0) AS "totalPnL"
                FROM roa_trades
                WHERE status != 'Open' ${acctAnd}
            `, acctParams),

            pool.query(`
                SELECT COALESCE(SUM("capitalGainLoss"), 0) AS gains
                FROM roa_positions
                WHERE "soldDate" IS NOT NULL ${acctAnd}
            `, acctParams),

            pool.query(`
                SELECT COALESCE(SUM("capitalGainLoss"), 0) AS gains
                FROM roa_stocks
                WHERE "soldDate" IS NOT NULL ${acctAnd}
            `, acctParams),

            pool.query(`
                SELECT COUNT(*) AS count FROM roa_trades
                WHERE status != 'Open' ${acctAnd}
            `, acctParams),

            pool.query(`
                SELECT COUNT(*) AS count FROM roa_stocks
                WHERE "soldDate" IS NOT NULL ${acctAnd}
            `, acctParams),

            pool.query(`
                SELECT COUNT(*) AS count FROM roa_positions
                WHERE "soldDate" IS NOT NULL ${acctAnd}
            `, acctParams),
        ]);

        // Fund totals by type
        const fundTotals = {};
        for (const row of fundResult.rows) {
            fundTotals[row.type] = toDollars(parseInt(row.total));
        }

        const deposits    = fundTotals.deposit    || 0;
        const withdrawals = fundTotals.withdrawal || 0;
        const dividends   = fundTotals.dividend   || 0;
        const interest    = fundTotals.interest   || 0;
        const fees        = fundTotals.fee        || 0;

        const optionsPnL      = toDollars(parseInt(optionsResult.rows[0].totalPnL));
        const positionGains   = toDollars(parseInt(posGainsResult.rows[0].gains));
        const manualStockGains = toDollars(parseInt(stockGainsResult.rows[0].gains));
        const totalStockGains = positionGains + manualStockGains;

        const netDeposited  = deposits - withdrawals;
        const totalPnL      = optionsPnL + totalStockGains + dividends + interest - fees;
        const rateOfReturn  = netDeposited > 0 ? (totalPnL / netDeposited) * 100 : 0;

        const closedTradesCount = parseInt(closedTradesResult.rows[0].count);
        const closedStocksCount = parseInt(closedStocksResult.rows[0].count);
        const closedPosCount    = parseInt(closedPosResult.rows[0].count);

        apiResponse.success(res, {
            netDeposited,
            totalDeposits: deposits,
            totalWithdrawals: withdrawals,
            totalPnL,
            rateOfReturn,
            optionsPnL,
            stockGains: totalStockGains,
            dividends,
            interest,
            fees,
            closedTradesCount,
            closedStockPositions: closedStocksCount + closedPosCount,
        });
    } catch (error) {
        console.error('Error fetching portfolio stats:', error);
        apiResponse.error(res, 'Failed to fetch portfolio stats');
    }
});

// GET /api/portfolio/monthly?accountId=X — Monthly P/L breakdown by source
router.get('/monthly', async (req, res) => {
    try {
        const { accountId } = req.query;
        const acctAnd    = accountId ? 'AND "accountId" = $1' : '';
        const acctParams = accountId ? [Number(accountId)] : [];

        // Run all monthly queries in parallel
        const [optionsResult, posGainsResult, stockGainsResult, incomeResult] = await Promise.all([

            // Monthly options P/L (realized only) — strftime → TO_CHAR
            pool.query(`
                SELECT
                    TO_CHAR(COALESCE("closedDate", "openedDate")::date, 'YYYY-MM') AS month,
                    SUM(CASE WHEN type IN ('CALL', 'PUT')
                             THEN ("closePrice" - "entryPrice") * quantity * 100 - commission
                             ELSE ("entryPrice" - "closePrice") * quantity * 100 - commission
                        END) AS pnl
                FROM roa_trades
                WHERE status != 'Open' ${acctAnd}
                GROUP BY month
                ORDER BY month
            `, acctParams),

            // Monthly position gains — strftime → TO_CHAR
            pool.query(`
                SELECT
                    TO_CHAR("soldDate"::date, 'YYYY-MM') AS month,
                    SUM("capitalGainLoss") AS gains
                FROM roa_positions
                WHERE "soldDate" IS NOT NULL ${acctAnd}
                GROUP BY month
            `, acctParams),

            // Monthly stock gains — strftime → TO_CHAR
            pool.query(`
                SELECT
                    TO_CHAR("soldDate"::date, 'YYYY-MM') AS month,
                    SUM("capitalGainLoss") AS gains
                FROM roa_stocks
                WHERE "soldDate" IS NOT NULL ${acctAnd}
                GROUP BY month
            `, acctParams),

            // Monthly income (dividends + interest - fees) — strftime → TO_CHAR
            pool.query(`
                SELECT
                    TO_CHAR(date::date, 'YYYY-MM') AS month,
                    type,
                    SUM(amount) AS total
                FROM roa_fund_transactions
                WHERE type IN ('dividend', 'interest', 'fee') ${acctAnd}
                GROUP BY month, type
                ORDER BY month
            `, acctParams),
        ]);

        // Merge all sources by month
        const months = new Map();

        const ensureMonth = (m) => {
            if (!months.has(m)) months.set(m, { month: m, options: 0, stocks: 0, income: 0 });
            return months.get(m);
        };

        for (const row of optionsResult.rows) {
            ensureMonth(row.month).options = toDollars(parseInt(row.pnl));
        }
        for (const row of posGainsResult.rows) {
            ensureMonth(row.month).stocks += toDollars(parseInt(row.gains));
        }
        for (const row of stockGainsResult.rows) {
            ensureMonth(row.month).stocks += toDollars(parseInt(row.gains));
        }
        for (const row of incomeResult.rows) {
            const entry = ensureMonth(row.month);
            if (row.type === 'fee') {
                entry.income -= toDollars(parseInt(row.total));
            } else {
                entry.income += toDollars(parseInt(row.total));
            }
        }

        const data = Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month));

        apiResponse.success(res, data);
    } catch (error) {
        console.error('Error fetching monthly portfolio data:', error);
        apiResponse.error(res, 'Failed to fetch monthly portfolio data');
    }
});

export default router;
