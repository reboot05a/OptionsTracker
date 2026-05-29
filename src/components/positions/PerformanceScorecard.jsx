import React from 'react';
import { Activity } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import { calculateMetrics } from '../../utils/calculations';

// ── Tunable constants ──────────────────────────────────────────
const INCEPTION_DATE      = '2026-05-18';   // update via Settings later
const TARGET_MONTHLY_PCT  = 2.0;            // 2%/month = 24% annualized target
const YIELD_GREEN_MULT    = 1.0;            // at or above target → green
const YIELD_YELLOW_MULT   = 0.6;            // 60–99% of target → yellow

// ── Helpers ────────────────────────────────────────────────────
function tradingDaysSince(dateStr) {
    const start = new Date(dateStr + 'T12:00:00');
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00');
    let count = 0;
    const d = new Date(start);
    while (d <= today) {
        if (d.getDay() !== 0 && d.getDay() !== 6) count++;
        d.setDate(d.getDate() + 1);
    }
    return count;
}

const fmtYield = (y) => (y != null && isFinite(y) ? `${y.toFixed(1)}%` : '—');

// ── Gauge ──────────────────────────────────────────────────────
const Gauge = ({ collectedYield, targetYield }) => {
    const pct = targetYield > 0 ? collectedYield / targetYield : 0;
    const isGreen  = pct >= YIELD_GREEN_MULT;
    const isYellow = pct >= YIELD_YELLOW_MULT;

    const cfg = isGreen
        ? { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-300 dark:border-emerald-700',
            dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'ON TRACK',
            labelCls: 'text-emerald-700 dark:text-emerald-400' }
        : isYellow
        ? { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-300 dark:border-amber-700',
            dot: 'bg-amber-500', bar: 'bg-amber-500', label: 'BUILDING',
            labelCls: 'text-amber-700 dark:text-amber-400' }
        : { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-300 dark:border-red-700',
            dot: 'bg-red-500', bar: 'bg-red-500', label: 'BELOW TARGET',
            labelCls: 'text-red-700 dark:text-red-400' };

    return (
        <div className={`rounded-lg border p-3 ${cfg.bg} ${cfg.border}`}>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Status</div>
            <div className="flex items-center gap-1.5 mb-1">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot} animate-pulse`} />
                <span className={`text-sm font-bold ${cfg.labelCls}`}>{cfg.label}</span>
            </div>
            <div className="h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${cfg.bar} transition-all`}
                     style={{ width: `${Math.min(100, pct * 100).toFixed(0)}%` }} />
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
                {fmtYield(collectedYield)} ann. vs {fmtYield(targetYield)} target
            </div>
        </div>
    );
};

// ── Metric tile ─────────────────────────────────────────────────
const Tile = ({ label, value, sub, valueColor = 'text-slate-800 dark:text-slate-100' }) => (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</div>
        <div className={`text-xl font-bold font-mono ${valueColor}`}>{value}</div>
        {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
);

// ── Main component ──────────────────────────────────────────────
export const PerformanceScorecard = ({ trades = [], positions = [], deployedCapital = 0 }) => {
    const tradingDays  = tradingDaysSince(INCEPTION_DATE);
    const annFactor    = tradingDays > 0 ? 252 / tradingDays : 0;
    const targetAnn    = TARGET_MONTHLY_PCT * 12;

    const ccTrades = trades.filter(t => t.type === 'CC');

    // Gross premium collected across ALL CC trades (open + closed)
    const totalCollected = ccTrades.reduce(
        (sum, t) => sum + (t.entryPrice * (t.quantity || 1) * 100), 0
    );

    // Net realized P/L from fully closed/expired CC trades
    const realizedPnL = ccTrades
        .filter(t => t.status !== 'Open' && t.status !== 'Rolled')
        .reduce((sum, t) => sum + calculateMetrics(t).pnl, 0);

    // Coverage: positions with an active CC
    const coveredCount   = positions.filter(p => p.cc).length;
    const totalPositions = positions.length;
    const coveragePct    = totalPositions > 0 ? (coveredCount / totalPositions) * 100 : 0;

    // Annualized yields
    const collectedYieldAnn = deployedCapital > 0
        ? (totalCollected / deployedCapital) * annFactor * 100 : 0;

    const inceptionLabel = new Date(INCEPTION_DATE + 'T12:00:00')
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    return (
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
                <Activity className="w-4 h-4 text-indigo-500" />
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Performance Scorecard
                </span>
                <span className="text-xs text-slate-400">
                    · Day {tradingDays} since {inceptionLabel}
                </span>
            </div>

            {/* Metric grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <Gauge collectedYield={collectedYieldAnn} targetYield={targetAnn} />

                <Tile
                    label="Collected"
                    value={formatCurrency(totalCollected)}
                    sub={`Ann. yield: ${fmtYield(collectedYieldAnn)}`}
                    valueColor="text-emerald-600 dark:text-emerald-400"
                />

                <Tile
                    label="Realized"
                    value={formatCurrency(realizedPnL)}
                    sub="From closed trades only"
                    valueColor={realizedPnL >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-500 dark:text-red-400'}
                />

                <Tile
                    label="Deployed"
                    value={formatCurrency(deployedCapital)}
                    sub="Capital in shares"
                    valueColor="text-indigo-600 dark:text-indigo-400"
                />

                <Tile
                    label="Coverage"
                    value={`${coveragePct.toFixed(0)}%`}
                    sub={`${coveredCount} of ${totalPositions} positions`}
                    valueColor={
                        coveragePct >= 80 ? 'text-emerald-600 dark:text-emerald-400'
                        : coveragePct >= 55 ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-500 dark:text-red-400'
                    }
                />

                <Tile
                    label="Target"
                    value={`${TARGET_MONTHLY_PCT}%/mo`}
                    sub={`${fmtYield(targetAnn)} annualized`}
                    valueColor="text-slate-500 dark:text-slate-400"
                />
            </div>
        </div>
    );
};
