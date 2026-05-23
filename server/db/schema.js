import { pool } from './connection.js';

// Single idempotent schema creation — replaces the 18-migration SQLite chain.
// All ROA tables use the roa_ prefix to coexist with the shared Railway Postgres
// instance (which also holds cc_daily_candidates, tm_market_data_daily_cache, etc.)
// camelCase column names are double-quoted so pg returns them with correct casing.

export const createSchema = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ── roa_accounts ─────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_accounts (
                id                      BIGSERIAL PRIMARY KEY,
                name                    TEXT NOT NULL CHECK(length(name) > 0),
                "commissionPerContract" INTEGER NOT NULL DEFAULT 0,
                "accountValue"          REAL NOT NULL DEFAULT 0,
                "createdAt"             TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt"             TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_trades ────────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_trades (
                id               BIGSERIAL PRIMARY KEY,
                ticker           TEXT NOT NULL CHECK(length(ticker) > 0),
                type             TEXT NOT NULL CHECK(type IN ('CSP', 'CC', 'CALL', 'PUT')),
                strike           INTEGER NOT NULL CHECK(strike > 0),
                quantity         INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
                delta            REAL CHECK(delta IS NULL OR (delta >= 0 AND delta <= 1)),
                "entryPrice"     INTEGER NOT NULL CHECK("entryPrice" >= 0),
                "closePrice"     INTEGER DEFAULT 0 CHECK("closePrice" >= 0),
                "openedDate"     TEXT NOT NULL,
                "expirationDate" TEXT NOT NULL,
                "closedDate"     TEXT,
                status           TEXT NOT NULL DEFAULT 'Open'
                                     CHECK(status IN ('Open', 'Expired', 'Assigned', 'Closed', 'Rolled')),
                "parentTradeId"  BIGINT REFERENCES roa_trades(id) ON DELETE SET NULL,
                notes            TEXT,
                "accountId"      BIGINT REFERENCES roa_accounts(id) ON DELETE RESTRICT,
                commission       INTEGER NOT NULL DEFAULT 0,
                score            REAL,
                iv               REAL,
                "createdAt"      TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt"      TIMESTAMPTZ DEFAULT NOW(),
                CHECK("expirationDate" >= "openedDate")
            )
        `);

        // ── roa_positions ─────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_positions (
                id                     BIGSERIAL PRIMARY KEY,
                ticker                 TEXT NOT NULL CHECK(length(ticker) > 0),
                shares                 INTEGER NOT NULL CHECK(shares >= 1),
                "costBasis"            INTEGER NOT NULL CHECK("costBasis" >= 0),
                "acquiredDate"         TEXT NOT NULL,
                "acquiredFromTradeId"  BIGINT REFERENCES roa_trades(id) ON DELETE CASCADE,
                "soldDate"             TEXT,
                "salePrice"            INTEGER CHECK("salePrice" IS NULL OR "salePrice" >= 0),
                "soldViaTradeId"       BIGINT REFERENCES roa_trades(id) ON DELETE SET NULL,
                "capitalGainLoss"      INTEGER,
                "accountId"            BIGINT REFERENCES roa_accounts(id) ON DELETE RESTRICT,
                "createdAt"            TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt"            TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_stocks ────────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_stocks (
                id               BIGSERIAL PRIMARY KEY,
                "accountId"      BIGINT NOT NULL REFERENCES roa_accounts(id) ON DELETE RESTRICT,
                ticker           TEXT NOT NULL CHECK(length(ticker) > 0),
                shares           INTEGER NOT NULL CHECK(shares >= 1),
                "costBasis"      INTEGER NOT NULL CHECK("costBasis" >= 0),
                "acquiredDate"   TEXT NOT NULL,
                "soldDate"       TEXT,
                "salePrice"      INTEGER CHECK("salePrice" IS NULL OR "salePrice" >= 0),
                "capitalGainLoss" INTEGER,
                notes            TEXT,
                "createdAt"      TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt"      TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_price_cache ───────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_price_cache (
                ticker          TEXT PRIMARY KEY,
                price           INTEGER NOT NULL,
                change          INTEGER,
                "changePercent" REAL,
                name            TEXT,
                "updatedAt"     TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_settings ──────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_fund_transactions ─────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_fund_transactions (
                id           BIGSERIAL PRIMARY KEY,
                "accountId"  BIGINT NOT NULL REFERENCES roa_accounts(id) ON DELETE RESTRICT,
                type         TEXT NOT NULL CHECK(type IN ('deposit','withdrawal','dividend','interest','fee')),
                amount       INTEGER NOT NULL CHECK(amount > 0),
                date         TEXT NOT NULL,
                description  TEXT,
                "createdAt"  TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt"  TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── roa_monitor_recommendations ────────────────────────────────────────
        // snake_case columns intentional — matches WF42 POST payload keys
        await client.query(`
            CREATE TABLE IF NOT EXISTS roa_monitor_recommendations (
                id              BIGSERIAL PRIMARY KEY,
                ticker          TEXT NOT NULL,
                position_type   TEXT NOT NULL,
                account_id      BIGINT NOT NULL REFERENCES roa_accounts(id),
                recommendation  TEXT NOT NULL,
                composite_tis   TEXT,
                rationale       TEXT,
                contract_detail TEXT,
                run_date        TEXT NOT NULL,
                asof_date       TEXT,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── Indexes ────────────────────────────────────────────────────────────
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_roa_trades_status
                ON roa_trades(status);
            CREATE INDEX IF NOT EXISTS idx_roa_trades_ticker
                ON roa_trades(ticker);
            CREATE INDEX IF NOT EXISTS idx_roa_trades_openedDate
                ON roa_trades("openedDate");
            CREATE INDEX IF NOT EXISTS idx_roa_trades_expirationDate
                ON roa_trades("expirationDate");
            CREATE INDEX IF NOT EXISTS idx_roa_trades_closedDate
                ON roa_trades("closedDate");
            CREATE INDEX IF NOT EXISTS idx_roa_trades_parentTradeId
                ON roa_trades("parentTradeId");
            CREATE INDEX IF NOT EXISTS idx_roa_trades_status_openedDate
                ON roa_trades(status, "openedDate");
            CREATE INDEX IF NOT EXISTS idx_roa_trades_accountId
                ON roa_trades("accountId");
            CREATE INDEX IF NOT EXISTS idx_roa_positions_ticker
                ON roa_positions(ticker);
            CREATE INDEX IF NOT EXISTS idx_roa_positions_soldDate
                ON roa_positions("soldDate");
            CREATE INDEX IF NOT EXISTS idx_roa_positions_acquiredFromTradeId
                ON roa_positions("acquiredFromTradeId");
            CREATE INDEX IF NOT EXISTS idx_roa_positions_accountId
                ON roa_positions("accountId");
            CREATE INDEX IF NOT EXISTS idx_roa_stocks_accountId
                ON roa_stocks("accountId");
            CREATE INDEX IF NOT EXISTS idx_roa_stocks_ticker
                ON roa_stocks(ticker);
            CREATE INDEX IF NOT EXISTS idx_roa_fund_transactions_accountId
                ON roa_fund_transactions("accountId");
            CREATE INDEX IF NOT EXISTS idx_roa_fund_transactions_date
                ON roa_fund_transactions(date);
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_roa_monitor_rec_ticker_account
                ON roa_monitor_recommendations(ticker, account_id);
        `);

        // ── Seed settings (idempotent) ─────────────────────────────────────────
        await client.query(`
            INSERT INTO roa_settings (key, value) VALUES
                ('live_prices_enabled',    'true'),
                ('portfolio_mode_enabled', 'false'),
                ('pagination_enabled',     'true'),
                ('trades_per_page',        '5')
            ON CONFLICT (key) DO NOTHING
        `);

        // ── Seed default account (only if none exist) ──────────────────────────
        const acctCheck = await client.query('SELECT COUNT(*) AS count FROM roa_accounts');
        if (parseInt(acctCheck.rows[0].count) === 0) {
            await client.query(`
                INSERT INTO roa_accounts (name, "commissionPerContract")
                VALUES ('Paper Trading', 66)
            `);
        }

        await client.query('COMMIT');
        console.log('📊 ROA schema ready (PostgreSQL)');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Schema creation failed:', err);
        throw err;
    } finally {
        client.release();
    }
};
