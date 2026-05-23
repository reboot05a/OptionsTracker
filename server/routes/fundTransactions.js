import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toCents, fundTransactionToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validateFundTransaction } from '../utils/validation.js';

const router = Router();

// GET all fund transactions
router.get('/', async (req, res) => {
    try {
        const { accountId, type } = req.query;

        const conditions = [];
        const params = [];
        let paramIdx = 1;

        if (accountId) {
            conditions.push(`"accountId" = $${paramIdx++}`);
            params.push(Number(accountId));
        }

        if (type) {
            conditions.push(`type = $${paramIdx++}`);
            params.push(type);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT * FROM roa_fund_transactions ${whereClause} ORDER BY date DESC, id DESC`,
            params
        );

        apiResponse.success(res, result.rows.map(fundTransactionToApi));
    } catch (error) {
        console.error('Error fetching fund transactions:', error);
        apiResponse.error(res, 'Failed to fetch fund transactions');
    }
});

// GET single fund transaction
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_fund_transactions WHERE id = $1', [req.params.id]);
        const txn = result.rows[0];
        if (!txn) {
            return apiResponse.error(res, 'Fund transaction not found', 404);
        }
        apiResponse.success(res, fundTransactionToApi(txn));
    } catch (error) {
        console.error('Error fetching fund transaction:', error);
        apiResponse.error(res, 'Failed to fetch fund transaction');
    }
});

// POST create fund transaction
router.post('/', async (req, res) => {
    try {
        const validationErrors = validateFundTransaction(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const { accountId, type, amount, date, description } = req.body;

        const insertResult = await pool.query(`
            INSERT INTO roa_fund_transactions ("accountId", type, amount, date, description)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [
            Number(accountId),
            type,
            toCents(amount),
            date,
            description || null,
        ]);

        const newId = insertResult.rows[0].id;
        const fetchResult = await pool.query('SELECT * FROM roa_fund_transactions WHERE id = $1', [newId]);
        apiResponse.created(res, fundTransactionToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error creating fund transaction:', error);
        apiResponse.error(res, 'Failed to create fund transaction');
    }
});

// PUT update fund transaction
router.put('/:id', async (req, res) => {
    try {
        const currentResult = await pool.query('SELECT * FROM roa_fund_transactions WHERE id = $1', [req.params.id]);
        const current = currentResult.rows[0];
        if (!current) {
            return apiResponse.error(res, 'Fund transaction not found', 404);
        }

        const validationErrors = validateFundTransaction(req.body, true);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const type        = req.body.type ?? current.type;
        const amount      = req.body.amount !== undefined ? toCents(req.body.amount) : current.amount;
        const date        = req.body.date ?? current.date;
        const description = req.body.description !== undefined ? req.body.description : current.description;

        await pool.query(`
            UPDATE roa_fund_transactions
            SET type = $1, amount = $2, date = $3, description = $4, "updatedAt" = NOW()
            WHERE id = $5
        `, [type, amount, date, description, req.params.id]);

        const fetchResult = await pool.query('SELECT * FROM roa_fund_transactions WHERE id = $1', [req.params.id]);
        apiResponse.success(res, fundTransactionToApi(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error updating fund transaction:', error);
        apiResponse.error(res, 'Failed to update fund transaction');
    }
});

// DELETE fund transaction
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM roa_fund_transactions WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) {
            return apiResponse.error(res, 'Fund transaction not found', 404);
        }
        apiResponse.success(res, { deleted: true, id: parseInt(req.params.id) });
    } catch (error) {
        console.error('Error deleting fund transaction:', error);
        apiResponse.error(res, 'Failed to delete fund transaction');
    }
});

export default router;
