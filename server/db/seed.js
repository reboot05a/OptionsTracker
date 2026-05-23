import { pool } from './connection.js';

// Migration: Fix existing positions cost basis to include premium collected
// Cost basis should be strike - premium, not just strike
export const fixCostBasis = async () => {
    const result = await pool.query(`
        SELECT p.id, p."costBasis", p.shares, p."salePrice", t.strike, t."entryPrice"
        FROM roa_positions p
        JOIN roa_trades t ON p."acquiredFromTradeId" = t.id
        WHERE p."acquiredFromTradeId" IS NOT NULL
    `);
    const positionsToFix = result.rows;

    let fixedCount = 0;
    for (const pos of positionsToFix) {
        const correctCostBasis = pos.strike - pos.entryPrice;
        // Only fix if the cost basis is wrong (equals strike without premium adjustment)
        if (Math.abs(pos.costBasis - pos.strike) < 0.01) {
            let capitalGainLoss = null;
            if (pos.salePrice !== null) {
                capitalGainLoss = (pos.salePrice - correctCostBasis) * pos.shares;
            }
            await pool.query(`
                UPDATE roa_positions
                SET "costBasis" = $1,
                    "capitalGainLoss" = COALESCE($2, "capitalGainLoss"),
                    "updatedAt" = NOW()
                WHERE id = $3
            `, [correctCostBasis, capitalGainLoss, pos.id]);
            fixedCount++;
        }
    }
    if (fixedCount > 0) {
        console.log(`🔧 Fixed ${fixedCount} position(s) cost basis to include premium collected`);
    }
};

// Clean up orphaned positions (positions whose originating trade was deleted)
export const cleanOrphanedPositions = async () => {
    // Remove positions with NULL reference (acquiredFromTradeId cleared)
    const nullRef = await pool.query(`
        DELETE FROM roa_positions
        WHERE "acquiredFromTradeId" IS NULL
    `);

    // Remove positions whose originating trade no longer exists (stale foreign key)
    const staleRef = await pool.query(`
        DELETE FROM roa_positions
        WHERE "acquiredFromTradeId" IS NOT NULL
          AND "acquiredFromTradeId" NOT IN (SELECT id FROM roa_trades)
    `);

    // Clear sold fields on positions whose selling trade no longer exists
    const staleSold = await pool.query(`
        UPDATE roa_positions
        SET "soldDate" = NULL, "salePrice" = NULL, "soldViaTradeId" = NULL,
            "capitalGainLoss" = NULL, "updatedAt" = NOW()
        WHERE "soldViaTradeId" IS NOT NULL
          AND "soldViaTradeId" NOT IN (SELECT id FROM roa_trades)
    `);

    const total = (nullRef.rowCount || 0) + (staleRef.rowCount || 0);
    if (total > 0) {
        console.log(`🧹 Cleaned up ${total} orphaned position(s)`);
    }
    if ((staleSold.rowCount || 0) > 0) {
        console.log(`🧹 Reset ${staleSold.rowCount} position(s) with stale sold references`);
    }
};

// Seed example data if database is empty (for demo purposes)
// NOTE: All prices are in cents (e.g., $220 strike = 22000 cents)
export const seedDemoData = async () => {
    const countResult = await pool.query('SELECT COUNT(*) AS count FROM roa_trades');
    if (parseInt(countResult.rows[0].count) !== 0) return;

    console.log('Seeding example trades...');

    // Get default account ID (created by schema.js seed)
    const acctResult = await pool.query('SELECT id FROM roa_accounts ORDER BY id LIMIT 1');
    const acctId = acctResult.rows[0]?.id || null;

    const insertTrade = async (ticker, type, strike, quantity, delta, entryPrice, closePrice, openedDate, expirationDate, closedDate, status, parentTradeId, accountId) => {
        const result = await pool.query(`
            INSERT INTO roa_trades
                (ticker, type, strike, quantity, delta, "entryPrice", "closePrice",
                 "openedDate", "expirationDate", "closedDate", status, "parentTradeId", "accountId")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING id
        `, [ticker, type, strike, quantity, delta, entryPrice, closePrice,
            openedDate, expirationDate, closedDate, status, parentTradeId, accountId]);
        return result.rows[0].id;
    };

    const insertPosition = async (ticker, shares, costBasis, acquiredDate, acquiredFromTradeId, soldDate, salePrice, soldViaTradeId, capitalGainLoss, accountId) => {
        await pool.query(`
            INSERT INTO roa_positions
                (ticker, shares, "costBasis", "acquiredDate", "acquiredFromTradeId",
                 "soldDate", "salePrice", "soldViaTradeId", "capitalGainLoss", "accountId")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [ticker, shares, costBasis, acquiredDate, acquiredFromTradeId,
            soldDate, salePrice, soldViaTradeId, capitalGainLoss, accountId]);
    };

    // Example 1: AAPL - Simple CSP (expired worthless)
    await insertTrade('AAPL', 'CSP', 22000, 1, 0.25, 280, 0, '2025-11-18', '2025-12-20', '2025-12-20', 'Expired', null, acctId);

    // Example 2: MSFT - Simple CC (expired worthless)
    await insertTrade('MSFT', 'CC', 45000, 1, 0.30, 350, 0, '2025-11-20', '2025-12-20', '2025-12-20', 'Expired', null, acctId);

    // Example 3: META - Rolled CSP chain
    const metaRolledId = await insertTrade('META', 'CSP', 58000, 1, 0.28, 420, 650, '2025-11-15', '2025-12-20', '2025-12-18', 'Rolled', null, acctId);
    await insertTrade('META', 'CSP', 56000, 1, 0.25, 580, 0, '2025-12-18', '2026-01-17', null, 'Open', metaRolledId, acctId);

    // Example 4: NVDA - CSP Assigned then CC sold (full wheel cycle)
    const nvdaCspId = await insertTrade('NVDA', 'CSP', 13000, 1, 0.32, 380, 0, '2025-11-10', '2025-12-06', '2025-12-06', 'Assigned', null, acctId);
    const nvdaCcId  = await insertTrade('NVDA', 'CC',  14000, 1, 0.28, 450, 0, '2025-12-09', '2025-12-20', '2025-12-20', 'Assigned', nvdaCspId, acctId);

    // Position: cost basis $126.20 (strike $130 - premium $3.80), sold at $140
    await insertPosition('NVDA', 100, 12620, '2025-12-06', nvdaCspId, '2025-12-20', 14000, nvdaCcId, 138000, acctId);

    console.log('Example trades seeded!');
};
