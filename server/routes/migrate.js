/**
 * ONE-TIME SQLite → Postgres migration endpoint.
 *
 * POST /api/migrate
 *   Reads every table from the SQLite file on the Railway volume and
 *   bulk-inserts into the roa_* Postgres tables.  Safe to call on a
 *   freshly-created schema (seed data is wiped first).
 *
 * DELETE THIS FILE AND ITS ROUTE REGISTRATION after migration is confirmed.
 */

import { Router } from 'express';
import { createRequire } from 'module';
import { join } from 'path';
import { pool } from '../db/connection.js';

// better-sqlite3 is CommonJS — use createRequire to import from ESM
const require = createRequire(import.meta.url);

const router = Router();

router.post('/', async (req, res) => {
    // Safety guard — require explicit confirmation header so this can't be
    // triggered by accident
    if (req.headers['x-migrate-confirm'] !== 'yes-migrate-sqlite-to-pg') {
        return res.status(400).json({
            ok: false,
            error: 'Missing confirmation header: x-migrate-confirm: yes-migrate-sqlite-to-pg'
        });
    }

    const DATA_DIR = process.env.DATA_DIR;
    if (!DATA_DIR) {
        return res.status(500).json({ ok: false, error: 'DATA_DIR env var not set' });
    }

    const dbPath = join(DATA_DIR, 'optionable.db');
    console.log(`🚚 Migration starting — reading SQLite from ${dbPath}`);

    let sqlite;
    try {
        const Database = require('better-sqlite3');
        sqlite = new Database(dbPath, { readonly: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: `Failed to open SQLite: ${err.message}` });
    }

    // Helper: read a whole SQLite table
    const readAll = (table) => {
        try {
            return sqlite.prepare(`SELECT * FROM ${table}`).all();
        } catch {
            return []; // table may not exist in older schema versions
        }
    };

    // Snapshot all data from SQLite before touching Postgres
    const accounts         = readAll('accounts');
    const trades           = readAll('trades');
    const positions        = readAll('positions');
    const stocks           = readAll('stocks');
    const fundTransactions = readAll('fund_transactions');
    const monitorRecs      = readAll('monitor_recommendations');
    const priceCache       = readAll('price_cache');
    const settings         = readAll('settings');
    sqlite.close();

    console.log(`📖 Read from SQLite: accounts=${accounts.length} trades=${trades.length} positions=${positions.length} stocks=${stocks.length} fund_transactions=${fundTransactions.length} monitor_recommendations=${monitorRecs.length} price_cache=${priceCache.length} settings=${settings.length}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ── Wipe existing data (seed rows etc.) in reverse FK order ──────────
        await client.query('DELETE FROM roa_monitor_recommendations');
        await client.query('DELETE FROM roa_price_cache');
        await client.query('DELETE FROM roa_settings');
        await client.query('DELETE FROM roa_fund_transactions');
        await client.query('DELETE FROM roa_stocks');
        await client.query('DELETE FROM roa_positions');
        await client.query('DELETE FROM roa_trades');
        await client.query('DELETE FROM roa_accounts');

        // ── roa_accounts ──────────────────────────────────────────────────────
        for (const r of accounts) {
            await client.query(`
                INSERT INTO roa_accounts (id, name, "commissionPerContract", "accountValue", "createdAt", "updatedAt")
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [r.id, r.name, r.commissionPerContract ?? 0, r.accountValue ?? 0,
                r.createdAt ?? null, r.updatedAt ?? null]);
        }

        // ── roa_trades ────────────────────────────────────────────────────────
        for (const r of trades) {
            await client.query(`
                INSERT INTO roa_trades
                    (id, ticker, type, strike, quantity, delta, iv,
                     "entryPrice", "closePrice", "openedDate", "expirationDate",
                     "closedDate", status, "parentTradeId", notes, "accountId",
                     commission, score, "createdAt", "updatedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            `, [
                r.id, r.ticker, r.type, r.strike ?? 0, r.quantity ?? 1,
                r.delta ?? null, r.iv ?? null,
                r.entryPrice ?? 0, r.closePrice ?? 0,
                r.openedDate ?? null, r.expirationDate ?? null,
                r.closedDate ?? null, r.status ?? 'Open',
                r.parentTradeId ?? null, r.notes ?? null,
                r.accountId ?? null, r.commission ?? 0,
                r.score ?? null,
                r.createdAt ?? null, r.updatedAt ?? null,
            ]);
        }

        // ── roa_positions ─────────────────────────────────────────────────────
        for (const r of positions) {
            await client.query(`
                INSERT INTO roa_positions
                    (id, ticker, shares, "costBasis", "acquiredDate",
                     "acquiredFromTradeId", "soldDate", "salePrice",
                     "soldViaTradeId", "capitalGainLoss", "accountId",
                     "createdAt", "updatedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            `, [
                r.id, r.ticker, r.shares ?? 0, r.costBasis ?? 0,
                r.acquiredDate ?? null, r.acquiredFromTradeId ?? null,
                r.soldDate ?? null, r.salePrice ?? null,
                r.soldViaTradeId ?? null, r.capitalGainLoss ?? null,
                r.accountId ?? null,
                r.createdAt ?? null, r.updatedAt ?? null,
            ]);
        }

        // ── roa_stocks ────────────────────────────────────────────────────────
        for (const r of stocks) {
            await client.query(`
                INSERT INTO roa_stocks
                    (id, "accountId", ticker, shares, "costBasis",
                     "acquiredDate", "soldDate", "salePrice",
                     "capitalGainLoss", notes, "createdAt", "updatedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            `, [
                r.id, r.accountId ?? null, r.ticker, r.shares ?? 0,
                r.costBasis ?? 0, r.acquiredDate ?? null,
                r.soldDate ?? null, r.salePrice ?? null,
                r.capitalGainLoss ?? null, r.notes ?? null,
                r.createdAt ?? null, r.updatedAt ?? null,
            ]);
        }

        // ── roa_fund_transactions ─────────────────────────────────────────────
        for (const r of fundTransactions) {
            await client.query(`
                INSERT INTO roa_fund_transactions
                    (id, "accountId", type, amount, date, description,
                     "createdAt", "updatedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [
                r.id, r.accountId ?? null, r.type, r.amount ?? 0,
                r.date ?? null, r.description ?? null,
                r.createdAt ?? null, r.updatedAt ?? null,
            ]);
        }

        // ── roa_monitor_recommendations ───────────────────────────────────────
        for (const r of monitorRecs) {
            await client.query(`
                INSERT INTO roa_monitor_recommendations
                    (id, ticker, position_type, account_id, recommendation,
                     composite_tis, rationale, contract_detail,
                     run_date, asof_date, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            `, [
                r.id, r.ticker, r.position_type ?? null,
                r.account_id ?? null, r.recommendation ?? null,
                r.composite_tis ?? null, r.rationale ?? null,
                r.contract_detail ?? null,
                r.run_date ?? null, r.asof_date ?? null,
                r.created_at ?? null, r.updated_at ?? null,
            ]);
        }

        // ── roa_price_cache (PK = ticker, no sequence) ────────────────────────
        for (const r of priceCache) {
            await client.query(`
                INSERT INTO roa_price_cache (ticker, price, change, "changePercent", name, "updatedAt")
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (ticker) DO UPDATE SET
                    price           = EXCLUDED.price,
                    change          = EXCLUDED.change,
                    "changePercent" = EXCLUDED."changePercent",
                    name            = EXCLUDED.name,
                    "updatedAt"     = EXCLUDED."updatedAt"
            `, [r.ticker, r.price ?? 0, r.change ?? 0,
                r.changePercent ?? 0, r.name ?? '', r.updatedAt ?? null]);
        }

        // ── roa_settings (PK = key, no sequence) ─────────────────────────────
        for (const r of settings) {
            await client.query(`
                INSERT INTO roa_settings (key, value, "updatedAt")
                VALUES ($1, $2, $3)
                ON CONFLICT (key) DO UPDATE SET
                    value       = EXCLUDED.value,
                    "updatedAt" = EXCLUDED."updatedAt"
            `, [r.key, r.value ?? null, r.updatedAt ?? null]);
        }

        // ── Reset BIGSERIAL sequences so next INSERT gets the right id ─────────
        const seqTables = [
            ['roa_accounts',               'roa_accounts_id_seq'],
            ['roa_trades',                 'roa_trades_id_seq'],
            ['roa_positions',              'roa_positions_id_seq'],
            ['roa_stocks',                 'roa_stocks_id_seq'],
            ['roa_fund_transactions',      'roa_fund_transactions_id_seq'],
            ['roa_monitor_recommendations','roa_monitor_recommendations_id_seq'],
        ];
        for (const [table, seq] of seqTables) {
            await client.query(
                `SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM ${table}), 1))`
            );
        }

        await client.query('COMMIT');
        console.log('✅ Migration committed to Postgres');

        // Final row counts from Postgres for verification
        const counts = {};
        for (const t of ['roa_accounts','roa_trades','roa_positions','roa_stocks',
                          'roa_fund_transactions','roa_monitor_recommendations',
                          'roa_price_cache','roa_settings']) {
            const r = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
            counts[t] = parseInt(r.rows[0].n);
        }

        res.json({
            ok: true,
            message: 'Migration complete',
            sqlite_source: dbPath,
            row_counts: counts,
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed, rolled back:', err);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        client.release();
    }
});

export default router;
