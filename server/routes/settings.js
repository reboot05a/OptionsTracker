import { Router } from 'express';
import { pool } from '../db/connection.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

// GET all settings
router.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_settings');
        const settingsObj = Object.fromEntries(result.rows.map(s => [s.key, s.value]));
        apiResponse.success(res, settingsObj);
    } catch (error) {
        console.error('Error fetching settings:', error);
        apiResponse.error(res, 'Failed to fetch settings');
    }
});

// PUT update setting
router.put('/:key', async (req, res) => {
    try {
        const { value } = req.body;
        const key = req.params.key;

        await pool.query(`
            INSERT INTO roa_settings (key, value, "updatedAt")
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value       = EXCLUDED.value,
                "updatedAt" = NOW()
        `, [key, value]);

        apiResponse.success(res, { key, value });
    } catch (error) {
        console.error('Error updating setting:', error);
        apiResponse.error(res, 'Failed to update setting');
    }
});

// NOTE: The SQLite export-db endpoint has been removed — not applicable to Postgres.
// Database backups are handled by Railway's native Postgres backup infrastructure.

export default router;
