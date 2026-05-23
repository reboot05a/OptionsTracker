import { Router } from 'express';
import { pool } from '../db/connection.js';
import { toCents, accountToApi } from '../utils/conversions.js';
import { apiResponse } from '../utils/response.js';
import { validateAccount } from '../utils/validation.js';

const router = Router();

// Helper: merge accountValue (stored as plain dollars) into the accountToApi output
const mapAccount = (row) => ({ ...accountToApi(row), accountValue: row.accountValue || 0 });

// GET all accounts
router.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_accounts ORDER BY id ASC');
        apiResponse.success(res, result.rows.map(mapAccount));
    } catch (error) {
        console.error('Error fetching accounts:', error);
        apiResponse.error(res, 'Failed to fetch accounts');
    }
});

// GET single account
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roa_accounts WHERE id = $1', [req.params.id]);
        const account = result.rows[0];
        if (!account) {
            return apiResponse.error(res, 'Account not found', 404);
        }
        apiResponse.success(res, mapAccount(account));
    } catch (error) {
        console.error('Error fetching account:', error);
        apiResponse.error(res, 'Failed to fetch account');
    }
});

// POST create account
router.post('/', async (req, res) => {
    try {
        const validationErrors = validateAccount(req.body, false);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const commissionCents = toCents(req.body.commissionPerContract) || 0;
        const accountValue = req.body.accountValue != null ? Number(req.body.accountValue) || 0 : 0;

        const insertResult = await pool.query(
            'INSERT INTO roa_accounts (name, "commissionPerContract", "accountValue") VALUES ($1, $2, $3) RETURNING id',
            [req.body.name.trim(), commissionCents, accountValue]
        );
        const newId = insertResult.rows[0].id;

        const fetchResult = await pool.query('SELECT * FROM roa_accounts WHERE id = $1', [newId]);
        apiResponse.created(res, mapAccount(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error creating account:', error);
        apiResponse.error(res, 'Failed to create account');
    }
});

// PUT update account
router.put('/:id', async (req, res) => {
    try {
        const validationErrors = validateAccount(req.body, true);
        if (validationErrors.length > 0) {
            return apiResponse.error(res, 'Validation failed', 400, validationErrors);
        }

        const currentResult = await pool.query('SELECT * FROM roa_accounts WHERE id = $1', [req.params.id]);
        const current = currentResult.rows[0];
        if (!current) {
            return apiResponse.error(res, 'Account not found', 404);
        }

        const name = req.body.name !== undefined ? req.body.name.trim() : current.name;
        const commissionCents = req.body.commissionPerContract !== undefined
            ? (toCents(req.body.commissionPerContract) || 0)
            : current.commissionPerContract;
        const accountValue = req.body.accountValue !== undefined
            ? (Number(req.body.accountValue) || 0)
            : (current.accountValue || 0);

        await pool.query(
            'UPDATE roa_accounts SET name = $1, "commissionPerContract" = $2, "accountValue" = $3, "updatedAt" = NOW() WHERE id = $4',
            [name, commissionCents, accountValue, req.params.id]
        );

        // If commission rate changed, recalculate all trades for this account
        if (commissionCents !== current.commissionPerContract) {
            const tradesResult = await pool.query(
                'SELECT id, quantity, status FROM roa_trades WHERE "accountId" = $1',
                [req.params.id]
            );
            const trades = tradesResult.rows;
            for (const trade of trades) {
                const legs = (trade.status === 'Closed' || trade.status === 'Rolled') ? 2 : 1;
                const newCommission = commissionCents * (trade.quantity || 1) * legs;
                await pool.query(
                    'UPDATE roa_trades SET commission = $1, "updatedAt" = NOW() WHERE id = $2',
                    [newCommission, trade.id]
                );
            }
            console.log(`💰 Recalculated commission for ${trades.length} trades in account #${req.params.id}`);
        }

        const fetchResult = await pool.query('SELECT * FROM roa_accounts WHERE id = $1', [req.params.id]);
        apiResponse.success(res, mapAccount(fetchResult.rows[0]));
    } catch (error) {
        console.error('Error updating account:', error);
        apiResponse.error(res, 'Failed to update account');
    }
});

// DELETE account (only if no associated data)
router.delete('/:id', async (req, res) => {
    try {
        const accountId = req.params.id;

        // Check for associated data across all tables
        const [tc, pc, fc, sc] = await Promise.all([
            pool.query('SELECT COUNT(*) AS c FROM roa_trades WHERE "accountId" = $1', [accountId]),
            pool.query('SELECT COUNT(*) AS c FROM roa_positions WHERE "accountId" = $1', [accountId]),
            pool.query('SELECT COUNT(*) AS c FROM roa_fund_transactions WHERE "accountId" = $1', [accountId]),
            pool.query('SELECT COUNT(*) AS c FROM roa_stocks WHERE "accountId" = $1', [accountId]),
        ]);

        const tradeCount    = parseInt(tc.rows[0].c);
        const positionCount = parseInt(pc.rows[0].c);
        const fundCount     = parseInt(fc.rows[0].c);
        const stockCount    = parseInt(sc.rows[0].c);
        const total = tradeCount + positionCount + fundCount + stockCount;

        if (total > 0) {
            return apiResponse.error(res,
                `Cannot delete account with existing data (${tradeCount} trades, ${positionCount} positions, ${fundCount} transactions, ${stockCount} stocks). Move or delete the data first.`,
                409
            );
        }

        const delResult = await pool.query('DELETE FROM roa_accounts WHERE id = $1', [accountId]);
        if (delResult.rowCount === 0) {
            return apiResponse.error(res, 'Account not found', 404);
        }

        apiResponse.success(res, { deleted: true, id: parseInt(accountId) });
    } catch (error) {
        console.error('Error deleting account:', error);
        apiResponse.error(res, 'Failed to delete account');
    }
});

export default router;
