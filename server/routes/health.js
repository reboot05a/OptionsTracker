import { Router } from 'express';
import { pool } from '../db/connection.js';
import { apiResponse } from '../utils/response.js';

const router = Router();

router.get('/', async (req, res) => {
    try {
        const dbCheck = await pool.query('SELECT COUNT(*) AS count FROM roa_trades');
        apiResponse.success(res, {
            status: 'healthy',
            database: { connected: true, tradeCount: parseInt(dbCheck.rows[0].count) },
            version: process.env.npm_package_version || '0.16.0'
        });
    } catch (error) {
        console.error('Health check failed:', error);
        apiResponse.error(res, 'Service unhealthy', 503);
    }
});

export default router;
