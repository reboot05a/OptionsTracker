import { Router } from 'express';
import { db } from '../db/connection.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// POST /api/monitor/recommendations
// Batch upsert from WF42 — one record per ticker, new run always overwrites.
router.post('/recommendations', (req, res) => {
    try {
        const { accountId, run_date, asof_date, recommendations } = req.body;

        if (!accountId || !run_date || !Array.isArray(recommendations) || recommendations.length === 0) {
            return apiResponse.error(res, 'Missing required fields: accountId, run_date, recommendations[]', 400);
        }

        const upsert = db.prepare(`
            INSERT INTO monitor_recommendations
                (ticker, position_type, account_id, recommendation, composite_tis, rationale, contract_detail, run_date, asof_date, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(ticker, account_id) DO UPDATE SET
                position_type   = excluded.position_type,
                recommendation  = excluded.recommendation,
                composite_tis   = excluded.composite_tis,
                rationale       = excluded.rationale,
                contract_detail = excluded.contract_detail,
                run_date        = excluded.run_date,
                asof_date       = excluded.asof_date,
                updated_at      = datetime('now')
        `);

        const upsertAll = db.transaction((recs) => {
            for (const r of recs) {
                upsert.run(
                    r.ticker,
                    r.position_type,
                    Number(accountId),
                    r.recommendation,
                    r.composite_tis   ?? null,
                    r.rationale       ?? null,
                    r.contract_detail ? JSON.stringify(r.contract_detail) : null,
                    run_date,
                    asof_date ?? null
                );
            }
        });

        upsertAll(recommendations);

        apiResponse.created(res, { upserted: recommendations.length });
    } catch (error) {
        console.error('Error upserting monitor recommendations:', error);
        apiResponse.error(res, 'Failed to save monitor recommendations');
    }
});

// GET /api/monitor/recommendations?accountId=X
// Returns all recommendations with a computed is_stale flag (run_date < today).
router.get('/recommendations', (req, res) => {
    try {
        const { accountId } = req.query;

        const conditions = [];
        const params = [];

        if (accountId) {
            conditions.push('account_id = ?');
            params.push(Number(accountId));
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = db.prepare(`
            SELECT * FROM monitor_recommendations
            ${where}
            ORDER BY position_type, ticker
        `).all(...params);

        const today = new Date().toISOString().slice(0, 10);

        const data = rows.map(r => ({
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

export default router;
