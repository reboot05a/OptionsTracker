import React, { useMemo } from 'react';
import { Lock } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import { calculateMetrics } from '../../utils/calculations';

// ── Tunable constants ──────────────────────────────────────────
const TARGET_MONTHLY_PCT = 2.0;   // 2%/month = 24% annualized target
const YIELD_GREEN_MULT   = 1.0;   // at or above target → green
const YIELD_YELLOW_MULT  = 0.6;   // 60–99% of target → yellow

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

const fmtPct = (y) => (y != null && isFinite(y) ? `${y.toFixed(1)}%` : '—');
const pnlCls = (v) => v >= 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-red-500 dark:text-red-400';

// ── Mini metric tile ───────────────────────────────────────────
const Mini = ({ label, value, sub, valueColor }) => (
    <div>
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
        <div className={`text-base font-bold font-mono ${valueColor || 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
        {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
);

// ── Main component ─────────────────────────────────────────────
export const PerformanceScorecard = ({
    trades = [],
    positions = [],
    deployedCapital = 0,
    accountValue = 0,
    inceptionDate,
}) => {
    const INCEPTION = inceptionDate || '2026-05-18';

    const tradingDays = useMemo(() => tradingDaysSince(INCEPTION), [INCEPTION]);
    const annFactor   = tradingDays > 0 ? 252 / tradingDays : 0;
    const targetAnn   = TARGET_MONTHLY_PCT * 12;

    // ── Options track — derived from all CC trades ever ───────
    const { banked, allTimeSold } = useMemo(() => {
        const ccTrades = trades.filter(t => t.type === 'CC');
        const banked = ccTrades
            .filter(t => t.status !== 'Open' && t.status !== 'Rolled')
            .reduce((sum, t) => sum + calculateMetrics(t).pnl, 0);
        const allTimeSold = ccTrades.reduce(
            (sum, t) => sum + t.entryPrice * (t.quantity || 1) * 100, 0
        );
        return { banked, allTimeSold };
    }, [trades]);

    // ── Open CC totals — derived from positions ───────────────
    const premiumCollected = useMemo(
        () => positions.reduce((s, p) =>
            s + (p.cc ? p.cc.entryPrice * (p.cc.quantity || 1) * 100 : 0), 0),
        [positions]
    );
    const captured = useMemo(
        () => positions.reduce((s, p) => s + (p.optionsPnl ?? 0), 0),
        [positions]
    );
    const stockPnl = useMemo(
        () => positions.reduce((s, p) => s + (p.stockPnl ?? 0), 0),
        [positions]
    );

    // ── Capital split ─────────────────────────────────────────
    const coveredCount    = positions.filter(p => p.status === 'ACTIVE_CC').length;
    const uncoveredCount  = positions.filter(p => p.status === 'UNCOVERED').length;
    const coveredCapital  = positions
        .filter(p => p.status === 'ACTIVE_CC')
        .reduce((s, p) => s + (p.deployedCapital || 0), 0);
    const uncoveredCapital = positions
        .filter(p => p.status === 'UNCOVERED')
        .reduce((s, p) => s + (p.deployedCapital || 0), 0);

    // ── Combined totals ───────────────────────────────────────
    const openPosPnl = stockPnl + captured;           // open positions mark-to-market
    const lockedIn   = banked + captured;             // realized + current mid on open
    const combined   = banked + stockPnl + captured;  // hypothetical close-all

    // ── Yield / ON TRACK gauge ────────────────────────────────
    const collectedYieldAnn = deployedCapital > 0
        ? (allTimeSold / deployedCapital) * annFactor * 100 : 0;
    const yieldPct = targetAnn > 0 ? collectedYieldAnn / targetAnn : 0;

    const isGreen  = yieldPct >= YIELD_GREEN_MULT;
    const isYellow = yieldPct >= YIELD_YELLOW_MULT;

    const gaugeCfg = isGreen ? {
        dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'ON TRACK',
        labelCls: 'text-emerald-700 dark:text-emerald-400',
        border: 'border-emerald-300 dark:border-emerald-700',
        bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    } : isYellow ? {
        dot: 'bg-amber-500', bar: 'bg-amber-500', label: 'BUILDING',
        labelCls: 'text-amber-700 dark:text-amber-400',
        border: 'border-amber-300 dark:border-amber-700',
        bg: 'bg-amber-50 dark:bg-amber-900/20',
    } : {
        dot: 'bg-red-500', bar: 'bg-red-500', label: 'BELOW TARGET',
        labelCls: 'text-red-700 dark:text-red-400',
        border: 'border-red-300 dark:border-red-700',
        bg: 'bg-red-50 dark:bg-red-900/20',
    };

    const idleCapital = accountValue > 0 ? accountValue - deployedCapital : null;
    const pctDeployed = accountValue   > 0 ? (deployedCapital  / accountValue)    * 100 : null;
    const capturedPct = premiumCollected > 0 ? (captured / premiumCollected) * 100 : 0;

    const inceptionLabel = new Date(INCEPTION + 'T12:00:00')
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    return (
        <div className="space-y-2">

            {/* ── Top row: status gauge + account utilization ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

                {/* ON TRACK gauge */}
                <div className={`rounded-lg border p-3 ${gaugeCfg.bg} ${gaugeCfg.border}`}>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                        Strategy status · Day {tradingDays} since {inceptionLabel}
                    </div>
                    <div className="flex items-center gap-2 mb-1.5">
                        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${gaugeCfg.dot} animate-pulse`} />
                        <span className={`text-sm font-bold ${gaugeCfg.labelCls}`}>{gaugeCfg.label}</span>
                    </div>
                    <div className="h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${gaugeCfg.bar} transition-all`}
                             style={{ width: `${Math.min(100, yieldPct * 100).toFixed(0)}%` }} />
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">
                        {fmtPct(collectedYieldAnn)} ann. yield on deployed · target {fmtPct(targetAnn)}
                    </div>
                </div>

                {/* Account utilization */}
                <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                        Account{accountValue > 0 ? ` · ${formatCurrency(accountValue)} total` : ''}
                    </div>
                    <div className="flex items-baseline gap-3 mb-1.5">
                        <div>
                            <span className="text-base font-bold font-mono text-slate-800 dark:text-slate-100">
                                {formatCurrency(deployedCapital)}
                            </span>
                            <span className="text-[10px] text-slate-400 ml-1">in stocks</span>
                        </div>
                        {idleCapital != null && (
                            <div>
                                <span className="text-sm font-semibold font-mono text-slate-500 dark:text-slate-400">
                                    {formatCurrency(idleCapital)}
                                </span>
                                <span className="text-[10px] text-slate-400 ml-1">idle</span>
                            </div>
                        )}
                    </div>
                    {/* Segmented bar: covered (green) | uncovered (amber) | idle (slate bg) */}
                    <div className="h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                        <div className="flex h-full">
                            <div className="bg-emerald-500 transition-all"
                                 style={{ width: `${(pctDeployed != null ? coveredCapital / accountValue * 100 : coveredCapital / Math.max(deployedCapital, 1) * 100).toFixed(1)}%` }} />
                            <div className="bg-amber-400 transition-all"
                                 style={{ width: `${(pctDeployed != null ? uncoveredCapital / accountValue * 100 : uncoveredCapital / Math.max(deployedCapital, 1) * 100).toFixed(1)}%` }} />
                        </div>
                    </div>
                    <div className="flex gap-3 mt-1 text-[10px] text-slate-400 flex-wrap">
                        <span><span className="text-emerald-500">■</span> {coveredCount} covered</span>
                        <span><span className="text-amber-400">■</span> {uncoveredCount} uncovered</span>
                        {pctDeployed != null && (
                            <span><span className="text-slate-300 dark:text-slate-600">■</span> {fmtPct(100 - pctDeployed)} idle cash</span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Main two-track panel ── */}
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:divide-x md:divide-slate-200 md:dark:divide-slate-700">

                    {/* OPTIONS TRACK */}
                    <div className="md:pr-4">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Options</span>
                            <span className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded font-semibold">
                                {formatCurrency(allTimeSold)} all-time sold
                            </span>
                        </div>

                        {/* Open CCs */}
                        <div className="mb-2.5">
                            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Open positions</div>
                            <div className="flex items-start gap-3">
                                <Mini
                                    label="Collected"
                                    value={formatCurrency(premiumCollected)}
                                    sub="on open CCs"
                                />
                                <span className="text-slate-300 dark:text-slate-600 text-sm mt-3">→</span>
                                <div className="flex-1">
                                    <Mini
                                        label="Captured"
                                        value={formatCurrency(captured)}
                                        sub={`mid-mark · ${capturedPct.toFixed(0)}%`}
                                        valueColor={pnlCls(captured)}
                                    />
                                    <div className="h-1 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden mt-1.5">
                                        <div className="h-full bg-emerald-500 rounded-full transition-all"
                                             style={{ width: `${Math.min(100, Math.max(0, capturedPct)).toFixed(0)}%` }} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Banked */}
                        <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2">
                            <Lock className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                            <div className="flex-1">
                                <span className="text-sm font-bold font-mono text-emerald-600 dark:text-emerald-400">
                                    {formatCurrency(banked)}
                                </span>
                                <span className="text-[10px] text-slate-400 ml-2">banked · closed &amp; expired</span>
                            </div>
                            <span className="text-[10px] text-slate-400">locked in</span>
                        </div>
                    </div>

                    {/* STOCK TRACK */}
                    <div className="md:pl-4">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                Stock · {formatCurrency(deployedCapital)} deployed
                            </span>
                        </div>

                        {/* Covered / uncovered breakdown */}
                        <div className="space-y-1.5 mb-2.5">
                            <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/50 rounded-lg px-3 py-1.5">
                                <div className="flex-1 min-w-0">
                                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                        {coveredCount} covered position{coveredCount !== 1 ? 's' : ''}
                                    </span>
                                    <span className="text-[10px] text-slate-400 ml-2">generating CC income</span>
                                </div>
                                <span className="text-xs font-bold font-mono text-emerald-600 dark:text-emerald-400 flex-shrink-0">
                                    {formatCurrency(coveredCapital)}
                                </span>
                            </div>
                            {uncoveredCount > 0 && (
                                <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/50 rounded-lg px-3 py-1.5">
                                    <div className="flex-1 min-w-0">
                                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                            {uncoveredCount} uncovered
                                        </span>
                                        <span className="text-[10px] text-slate-400 ml-2">WAIT · no CC income</span>
                                    </div>
                                    <span className="text-xs font-bold font-mono text-amber-600 dark:text-amber-400 flex-shrink-0">
                                        {formatCurrency(uncoveredCapital)}
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Unrealized stock P/L */}
                        <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Unrealized:</span>
                            <span className={`text-sm font-bold font-mono ${pnlCls(stockPnl)}`}>
                                {stockPnl >= 0 ? '+' : ''}{formatCurrency(stockPnl)}
                            </span>
                            <span className="text-[10px] text-slate-400">stock only · not locked in</span>
                        </div>
                    </div>
                </div>

                {/* ── Combined totals row ── */}
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 flex flex-wrap items-start gap-x-6 gap-y-3">

                    <div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Open positions P/L</div>
                        <div className={`text-xl font-bold font-mono ${pnlCls(openPosPnl)}`}>{formatCurrency(openPosPnl)}</div>
                        <div className="text-[10px] text-slate-400">
                            {formatCurrency(stockPnl)} stock + {formatCurrency(captured)} options
                        </div>
                    </div>

                    <div className="hidden md:block w-px bg-slate-200 dark:bg-slate-700 self-stretch" />

                    <div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Options realized</div>
                        <div className={`text-xl font-bold font-mono ${pnlCls(lockedIn)}`}>{formatCurrency(lockedIn)}</div>
                        <div className="text-[10px] text-slate-400">
                            {formatCurrency(banked)} banked + {formatCurrency(captured)} captured
                        </div>
                    </div>

                    <div className="hidden md:block w-px bg-slate-200 dark:bg-slate-700 self-stretch" />

                    <div>
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">If all closed today</div>
                        <div className={`text-xl font-bold font-mono ${pnlCls(combined)}`}>{formatCurrency(combined)}</div>
                        <div className="text-[10px] text-slate-400">
                            {deployedCapital > 0
                                ? `${((combined / deployedCapital) * 100).toFixed(1)}% on deployed · `
                                : ''}Day {tradingDays}
                        </div>
                    </div>

                    {uncoveredCount > 0 && (
                        <div className="ml-auto self-center bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/50 rounded-lg px-3 py-1.5">
                            <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                                {formatCurrency(uncoveredCapital)} idle in stocks
                            </div>
                            <div className="text-[10px] text-slate-400">
                                cover {uncoveredCount} position{uncoveredCount > 1 ? 's' : ''} to maximize yield
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
