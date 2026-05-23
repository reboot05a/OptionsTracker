import { Router } from 'express';
import { pool } from '../db/connection.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// POST /api/monitor/recommendations
// Batch upsert from WF42 — one record per ticker, new run always overwrites.
router.post('/recommendations', async (req, res) => {
    try {
        // n8n may wrap the payload in an array — unwrap if so
        const payload = Array.isArray(req.body) ? req.body[0] : req.body;
        const { accountId, run_date, asof_date, recommendations } = payload;

        if (!accountId || !run_date || !Array.isArray(recommendations) || recommendations.length === 0) {
            return apiResponse.error(res, 'Missing required fields: accountId, run_date, recommendations[]', 400);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const r of recommendations) {
                await client.query(`
                    INSERT INTO roa_monitor_recommendations
                        (ticker, position_type, account_id, recommendation, composite_tis, rationale, contract_detail, run_date, asof_date, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                    ON CONFLICT (ticker, account_id) DO UPDATE SET
                        position_type   = EXCLUDED.position_type,
                        recommendation  = EXCLUDED.recommendation,
                        composite_tis   = EXCLUDED.composite_tis,
                        rationale       = EXCLUDED.rationale,
                        contract_detail = EXCLUDED.contract_detail,
                        run_date        = EXCLUDED.run_date,
                        asof_date       = EXCLUDED.asof_date,
                        updated_at      = NOW()
                `, [
                    r.ticker,
                    r.position_type,
                    Number(accountId),
                    r.recommendation,
                    r.composite_tis   ?? null,
                    r.rationale       ?? null,
                    r.contract_detail ? JSON.stringify(r.contract_detail) : null,
                    run_date,
                    asof_date ?? null,
                ]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        apiResponse.created(res, { upserted: recommendations.length });
    } catch (error) {
        console.error('Error upserting monitor recommendations:', error);
        apiResponse.error(res, 'Failed to save monitor recommendations');
    }
});

// GET /api/monitor/recommendations?accountId=X
// Returns all recommendations with a computed is_stale flag (run_date < today).
router.get('/recommendations', async (req, res) => {
    try {
        const { accountId } = req.query;

        const conditions = [];
        const params = [];
        let paramIdx = 1;

        if (accountId) {
            conditions.push(`account_id = $${paramIdx++}`);
            params.push(Number(accountId));
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(`
            SELECT * FROM roa_monitor_recommendations
            ${where}
            ORDER BY position_type, ticker
        `, params);

        const today = new Date().toISOString().slice(0, 10);

        const data = result.rows.map(r => ({
            ...r,
            contract_detail: r.contract_detail ? JSON.parse(r.contract_detail) : null,
            is_stale: r.run_date < today,
        }));

        apiResponse.success(res, data);
    } catch (error) {
        console.error('Error fetching monitor recommendations:', error);
        apiResponse.error(res, 'Failed to fetch monitor recommendations');
    }
});

// GET /api/monitor/debug
// Diagnostic endpoint — shows table status and row count.
router.get('/debug', async (req, res) => {
    try {
        const tableCheck = await pool.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'roa_monitor_recommendations'
        `);

        if (tableCheck.rows.length === 0) {
            return res.json({ ok: false, error: 'Table roa_monitor_recommendations does not exist — schema has not been applied' });
        }

        const rowsResult = await pool.query('SELECT * FROM roa_monitor_recommendations ORDER BY position_type, ticker');

        res.json({
            ok: true,
            row_count: rowsResult.rows.length,
            rows: rowsResult.rows,
        });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

export default router;
