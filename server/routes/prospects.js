import { Router } from 'express';
import { pool } from '../db/connection.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// ── GET /api/prospects ──────────────────────────────────────────────────────
// Returns all candidates for the most recent run_date, joined with their
// latest quote snapshot.  Mirrors what tradematic_schwab /candidates/today
// returns but reads Postgres directly — no HTTP hop.
router.get('/', async (req, res) => {
    try {
        // Resolve the most-recent run_date present in the DB.
        const dateResult = await pool.query(
            'SELECT MAX(run_date) AS run_date FROM cc_daily_candidates'
        );
        const run_date = dateResult.rows[0]?.run_date;

        if (!run_date) {
            return apiResponse.success(res, { run_date: null, candidates: [] });
        }

        const result = await pool.query(`
            SELECT
                c.ticker,
                c.recommendation,
                c.score,
                c.strike,
                c.expiration_date,
                c.dte,
                c.delta,
                c.iv,
                c.ivr,
                c.premium_mid,
                c.annualized_yield,
                c.bid,
                c.ask,
                c.open_interest,
                c.stock_price_snapshot,
                c.stock_ceiling,
                c.call_floor,
                c.breakeven,
                c.cushion_pct,
                c.status,
                c.paused,
                c.report_text,
                c.live_contract,
                c.run_date,
                s.stock_price,
                s.call_mid,
                s.call_bid,
                s.call_ask,
                s.stock_status,
                s.call_status,
                s.overall_status,
                s.captured_at
            FROM cc_daily_candidates c
            LEFT JOIN LATERAL (
                SELECT
                    stock_price, call_mid, call_bid, call_ask,
                    stock_status, call_status, overall_status, captured_at
                FROM   cc_quote_snapshots
                WHERE  run_date = $1 AND ticker = c.ticker
                ORDER  BY captured_at DESC
                LIMIT  1
            ) s ON TRUE
            WHERE c.run_date = $1
            ORDER BY c.score DESC NULLS LAST
        `, [run_date]);

        // live_contract is stored as JSONB — pg returns it already parsed.
        const candidates = result.rows.map(row => ({
            ...row,
            live_contract: row.live_contract ?? null,
        }));

        apiResponse.success(res, { run_date, candidates });
    } catch (error) {
        console.error('Error fetching prospects:', error);
        apiResponse.error(res, 'Failed to fetch prospects');
    }
});

// ── POST /api/prospects/status ──────────────────────────────────────────────
// Direct write to cc_daily_candidates.  Accepts { ticker, date, status?, paused? }.
// At least one of status or paused must be present.
router.post('/status', async (req, res) => {
    try {
        const { ticker, date, status, paused } = req.body;

        if (!ticker || !date) {
            return apiResponse.error(res, 'Missing required fields: ticker, date', 400);
        }
        if (status === undefined && paused === undefined) {
            return apiResponse.error(res, 'Provide at least one of: status, paused', 400);
        }

        // Build a dynamic SET clause so we only touch the fields that were sent.
        const setClauses = ['updated_at = NOW()'];
        const params = [];
        let idx = 1;

        if (status !== undefined) {
            setClauses.push(`status = $${idx++}`);
            params.push(status);
        }
        if (paused !== undefined) {
            setClauses.push(`paused = $${idx++}`);
            params.push(paused);
        }

        params.push(date);    // $idx
        params.push(ticker);  // $idx+1

        const result = await pool.query(`
            UPDATE cc_daily_candidates
            SET ${setClauses.join(', ')}
            WHERE run_date = $${idx++} AND ticker = $${idx++}
        `, params);

        if (result.rowCount === 0) {
            return apiResponse.error(res, `No candidate found for ticker=${ticker} date=${date}`, 404);
        }

        apiResponse.success(res, { updated: result.rowCount });
    } catch (error) {
        console.error('Error updating prospect status:', error);
        apiResponse.error(res, 'Failed to update prospect status');
    }
});

// ── POST /api/prospects/poll ────────────────────────────────────────────────
// Proxy to tradematic_schwab /poll_candidates.  Keeps the service URL
// server-side.  Returns 503 if TRADEMATIC_URL is not configured.
router.post('/poll', async (req, res) => {
    const base = process.env.TRADEMATIC_URL;

    if (!base) {
        return res.status(503).json({
            success: false,
            message: 'TRADEMATIC_URL env var is not configured on this service.',
        });
    }

    try {
        const upstream = await fetch(`${base}/poll_candidates`, {
            method: 'POST',
            signal: AbortSignal.timeout(40000),
        });

        const body = await upstream.json().catch(() => ({}));
        res.status(upstream.status).json(body);
    } catch (error) {
        console.error('Error proxying poll_candidates:', error);
        res.status(502).json({
            success: false,
            message: `Poll proxy failed: ${error.message}`,
        });
    }
});

export default router;
