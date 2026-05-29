import React, { useMemo } from 'react';
import { Lock } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import { calculateMetrics } from '../../utils/calculations';

// ── Tunable constants ──────────────────────────────────────────
const TARGET_MONTHLY_PCT = 2.0;
const YIELD_GREEN_MULT   = 1.0;
const YIELD_YELLOW_MULT  = 0.6;

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

    // ── Options track ─────────────────────────────────────────
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

    const premiumCollected = useMemo(
        () => positions.reduce((s, p) =>
            s + (p.cc ? p.cc.entryPrice * (p.cc.quantity || 1) * 100 : 0), 0),
        [positions]
    );
    const captured = useMemo(
        () => positions.reduce((s, p) => s + (p.optionsPnl ?? 0), 0),
        [positions]
    );

    // ── Stock track — split by covered / uncovered ────────────
    const coveredPositions   = positions.filter(p => p.status === 'ACTIVE_CC');
    const uncoveredPositions = positions.filter(p => p.status === 'UNCOVERED');

    const coveredCapital    = coveredPositions.reduce((s, p)   => s + (p.deployedCapital || 0), 0);
    const uncoveredCapital  = uncoveredPositions.reduce((s, p) => s + (p.deployedCapital || 0), 0);
    const coveredStockPnl   = coveredPositions.reduce((s, p)   => s + (p.stockPnl ?? 0), 0);
    const uncoveredStockPnl = uncoveredPositions.reduce((s, p) => s + (p.stockPnl ?? 0), 0);
    const stockPnl          = coveredStockPnl + uncoveredStockPnl;

    const coveredCurrentVal   = coveredCapital  + coveredStockPnl;
    const uncoveredCurrentVal = uncoveredCapital + uncoveredStockPnl;
    const totalCurrentVal     = deployedCapital  + stockPnl;

    // ── Combined ──────────────────────────────────────────────
    const openPosPnl = stockPnl + captured;
    const lockedIn   = banked   + captured;
    const combined   = banked   + stockPnl + captured;

    // ── Yield / gauge ─────────────────────────────────────────
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
    const pctDeployed = accountValue > 0 ? (deployedCapital / accountValue) * 100 : null;
    const pctCoveredOfAccount   = accountValue > 0 ? (coveredCapital  / accountValue) * 100 : (coveredCapital  / Math.max(deployedCapital, 1) * 100);
    const pctUncoveredOfAccount = accountValue > 0 ? (uncoveredCapital / accountValue) * 100 : (uncoveredCapital / Math.max(deployedCapital, 1) * 100);
    const capturedPct = premiumCollected > 0 ? (captured / premiumCollected) * 100 : 0;

    const inceptionLabel = new Date(INCEPTION + 'T12:00:00')
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // ── Stock table helpers ───────────────────────────────────
    const COL = 'w-28 text-right flex-shrink-0';
    const ColHdr = ({ children }) => (
        <div className={`text-xs font-semibold text-slate-400 uppercase tracking-wide ${COL}`}>{children}</div>
    );
    const MonoVal = ({ value, color }) => (
        <div className={`text-sm font-bold font-mono ${COL} ${color || 'text-slate-700 dark:text-slate-200'}`}>{value}</div>
    );

    return (
        <div className="space-y-2">

            {/* ── Top row: strategy status + account ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

                {/* ON TRACK gauge */}
                <div className={`rounded-lg border p-4 ${gaugeCfg.bg} ${gaugeCfg.border}`}>
                    <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                        Strategy status · Day {tradingDays} since {inceptionLabel}
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                        <div className={`w-3 h-3 rounded-full flex-shrink-0 ${gaugeCfg.dot} animate-pulse`} />
                        <span className={`text-lg font-bold ${gaugeCfg.labelCls}`}>{gaugeCfg.label}</span>
                    </div>
                    <div className="h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden mb-1.5">
                        <div className={`h-full rounded-full ${gaugeCfg.bar} transition-all`}
                             style={{ width: `${Math.min(100, yieldPct * 100).toFixed(0)}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                        {fmtPct(collectedYieldAnn)} ann. yield on deployed · target {fmtPct(targetAnn)}
                    </div>
                </div>

                {/* Account utilization */}
                <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Account</div>
                    <div className="grid grid-cols-3 gap-4 mb-3">
                        <div>
                            <div className="text-xs text-slate-400 mb-0.5">Total</div>
                            {accountValue > 0 ? (
                                <>
                                    <div className="text-base font-bold font-mono text-slate-700 dark:text-slate-200">
                                        {formatCurrency(accountValue)}
                                    </div>
                                    <div className="text-xs text-slate-400">account size</div>
                                </>
                            ) : (
                                <>
                                    <div className="text-sm font-semibold text-slate-400 dark:text-slate-500">not set</div>
                                    <div className="text-xs text-slate-400">set in Settings →</div>
                                </>
                            )}
                        </div>
                        <div>
                            <div className="text-xs text-slate-400 mb-0.5">In stocks</div>
                            <div className="text-base font-bold font-mono text-slate-700 dark:text-slate-200">
                                {formatCurrency(deployedCapital)}
                            </div>
                            <div className="text-xs text-slate-400">
                                {pctDeployed != null ? `${fmtPct(pctDeployed)} deployed` : `${coveredPositions.length + uncoveredPositions.length} positions`}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-400 mb-0.5">Idle cash</div>
                            {idleCapital != null ? (
                                <>
                                    <div className={`text-base font-bold font-mono ${idleCapital >= 0 ? 'text-slate-700 dark:text-slate-200' : 'text-red-500 dark:text-red-400'}`}>
                                        {formatCurrency(idleCapital)}
                                    </div>
                                    <div className="text-xs text-slate-400">{fmtPct(100 - pctDeployed)} available</div>
                                </>
                            ) : (
                                <>
                                    <div className="text-sm font-semibold text-slate-400 dark:text-slate-500">—</div>
                                    <div className="text-xs text-slate-400">set account value</div>
                                </>
                            )}
                        </div>
                    </div>
                    {/* Segmented bar */}
                    <div className="h-2 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                        <div className="flex h-full">
                            <div className="bg-emerald-500 transition-all" style={{ width: `${pctCoveredOfAccount.toFixed(1)}%` }} />
                            <div className="bg-amber-400 transition-all" style={{ width: `${pctUncoveredOfAccount.toFixed(1)}%` }} />
                        </div>
                    </div>
                    <div className="flex gap-4 mt-1.5 text-xs text-slate-400">
                        <span><span className="text-emerald-500">■</span> {coveredPositions.length} covered</span>
                        <span><span className="text-amber-400">■</span> {uncoveredPositions.length} uncovered</span>
                        {pctDeployed != null && <span><span className="text-slate-300 dark:text-slate-600">■</span> idle cash</span>}
                    </div>
                </div>
            </div>

            {/* ── Main two-track panel ── */}
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:divide-x md:divide-slate-200 md:dark:divide-slate-700">

                    {/* OPTIONS TRACK */}
                    <div className="md:pr-4">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Options</span>
                            <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded font-semibold">
                                {formatCurrency(allTimeSold)} all-time sold
                            </span>
                        </div>

                        {/* Open CCs */}
                        <div className="mb-3">
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Open positions</div>
                            <div className="flex items-start gap-4">
                                <div>
                                    <div className="text-xs text-slate-400 mb-0.5">Collected</div>
                                    <div className="text-lg font-bold font-mono text-slate-700 dark:text-slate-200">
                                        {formatCurrency(premiumCollected)}
                                    </div>
                                    <div className="text-xs text-slate-400">on open CCs</div>
                                </div>
                                <span className="text-slate-300 dark:text-slate-600 text-base mt-4">→</span>
                                <div className="flex-1">
                                    <div className="text-xs text-slate-400 mb-0.5">Captured</div>
                                    <div className={`text-lg font-bold font-mono ${pnlCls(captured)}`}>
                                        {formatCurrency(captured)}
                                    </div>
                                    <div className="text-xs text-slate-400">mid-mark · {capturedPct.toFixed(0)}%</div>
                                    <div className="h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden mt-1.5">
                                        <div className="h-full bg-emerald-500 rounded-full transition-all"
                                             style={{ width: `${Math.min(100, Math.max(0, capturedPct)).toFixed(0)}%` }} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Banked */}
                        <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2.5">
                            <Lock className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                            <div className="flex-1">
                                <span className="text-base font-bold font-mono text-emerald-600 dark:text-emerald-400">
                                    {formatCurrency(banked)}
                                </span>
                                <span className="text-xs text-slate-400 ml-2">banked · closed &amp; expired</span>
                            </div>
                            <span className="text-xs text-slate-400">locked in</span>
                        </div>
                    </div>

                    {/* STOCK TRACK */}
                    <div className="md:pl-4">
                        <div className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">
                            Stock · {formatCurrency(deployedCapital)} deployed
                        </div>

                        {/* Table: covered / uncovered / totals */}
                        <div className="mb-3">
                            {/* Column headers */}
                            <div className="flex items-end gap-2 mb-2 pr-1">
                                <div className="flex-1" />
                                <ColHdr>Cost basis</ColHdr>
                                <ColHdr>Current val</ColHdr>
                                <ColHdr>Unrealized</ColHdr>
                            </div>

                            {/* Covered row */}
                            <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/50 rounded-lg px-3 py-2 mb-2">
                                <div className="flex-1 min-w-0">
                                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                                        {coveredPositions.length} covered
                                    </span>
                                    <span className="text-xs font-normal text-slate-400 ml-2">generating CC income</span>
                                </div>
                                <MonoVal value={formatCurrency(coveredCapital)} />
                                <MonoVal value={formatCurrency(coveredCurrentVal)} color={pnlCls(coveredStockPnl)} />
                                <MonoVal
                                    value={`${coveredStockPnl >= 0 ? '+' : ''}${formatCurrency(coveredStockPnl)}`}
                                    color={pnlCls(coveredStockPnl)}
                                />
                            </div>

                            {/* Uncovered row */}
                            {uncoveredPositions.length > 0 && (
                                <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/50 rounded-lg px-3 py-2 mb-2">
                                    <div className="flex-1 min-w-0">
                                        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                                            {uncoveredPositions.length} uncovered
                                        </span>
                                        <span className="text-xs font-normal text-slate-400 ml-2">WAIT · no CC income</span>
                                    </div>
                                    <MonoVal value={formatCurrency(uncoveredCapital)} />
                                    <MonoVal value={formatCurrency(uncoveredCurrentVal)} color={pnlCls(uncoveredStockPnl)} />
                                    <MonoVal
                                        value={`${uncoveredStockPnl >= 0 ? '+' : ''}${formatCurrency(uncoveredStockPnl)}`}
                                        color={pnlCls(uncoveredStockPnl)}
                                    />
                                </div>
                            )}

                            {/* Totals row — px-3 matches the padding inside bordered rows above */}
                            <div className="flex items-center gap-2 border-t border-slate-200 dark:border-slate-700 pt-2 px-3">
                                <div className="flex-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Total</div>
                                <MonoVal value={formatCurrency(deployedCapital)} color="text-slate-600 dark:text-slate-300" />
                                <MonoVal value={formatCurrency(totalCurrentVal)} color="text-slate-600 dark:text-slate-300" />
                                <MonoVal
                                    value={`${stockPnl >= 0 ? '+' : ''}${formatCurrency(stockPnl)}`}
                                    color={pnlCls(stockPnl)}
                                />
                            </div>
                        </div>

                        {/* Realized stock (closed positions) */}
                        <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2.5">
                            <Lock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                            <div className="flex-1">
                                <span className="text-base font-bold font-mono text-slate-500 dark:text-slate-400">$0.00</span>
                                <span className="text-xs text-slate-400 ml-2">realized stock · no closed positions yet</span>
                            </div>
                            <span className="text-xs text-slate-400">locked in</span>
                        </div>
                    </div>
                </div>

                {/* ── Combined totals row ── */}
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700">
                    <div className="grid grid-cols-[auto_1px_1fr_1px_1fr_auto] gap-x-4 items-start">

                        {/* LEFT — options only */}
                        <div>
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Options realized</div>
                            <div className={`text-xl font-bold font-mono ${pnlCls(lockedIn)}`}>{formatCurrency(lockedIn)}</div>
                            <div className="text-xs text-slate-400">
                                {formatCurrency(banked)} banked + {formatCurrency(captured)} captured
                            </div>
                        </div>

                        <div className="bg-slate-200 dark:bg-slate-700 self-stretch" />

                        {/* CENTER LEFT — open positions combined */}
                        <div>
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Open positions P/L</div>
                            <div className={`text-xl font-bold font-mono ${pnlCls(openPosPnl)}`}>{formatCurrency(openPosPnl)}</div>
                            <div className="text-xs text-slate-400">
                                {formatCurrency(stockPnl)} stock + {formatCurrency(captured)} options
                            </div>
                        </div>

                        <div className="bg-slate-200 dark:bg-slate-700 self-stretch" />

                        {/* CENTER RIGHT — close-all scenario */}
                        <div>
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-0.5">If all closed today</div>
                            <div className={`text-xl font-bold font-mono ${pnlCls(combined)}`}>{formatCurrency(combined)}</div>
                            <div className="text-xs text-slate-400">
                                {deployedCapital > 0
                                    ? `${((combined / deployedCapital) * 100).toFixed(1)}% on deployed · `
                                    : ''}Day {tradingDays}
                            </div>
                        </div>

                        {/* RIGHT — uncovered warning (only if applicable) */}
                        {uncoveredPositions.length > 0 && (
                            <div className="self-center bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/50 rounded-lg px-3 py-2">
                                <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                                    {formatCurrency(uncoveredCapital)} idle in stocks
                                </div>
                                <div className="text-xs text-slate-400">
                                    cover {uncoveredPositions.length} position{uncoveredPositions.length > 1 ? 's' : ''} to maximize yield
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
