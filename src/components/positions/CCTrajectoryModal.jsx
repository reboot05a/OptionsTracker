import React, { useState, useMemo } from 'react';
import { X, Info } from 'lucide-react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, ReferenceDot, ReferenceLine,
    AreaChart, Area,
} from 'recharts'; // Line used in Tab 0 (LineChart)

// ── Black-Scholes ─────────────────────────────────────────────────────────────
const RISK_FREE_RATE = 0.05;

function normCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

function bsCall(S, K, T, sigma, r = RISK_FREE_RATE) {
    if (T <= 0) return Math.max(0, S - K);
    if (sigma <= 0) return Math.max(0, S - K * Math.exp(-r * T));
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
}

function bsDelta(S, K, T, sigma, r = RISK_FREE_RATE) {
    if (T <= 0 || sigma <= 0) return S >= K ? 1 : 0;
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    return normCDF(d1);
}

function bsTheta(S, K, T, sigma, r = RISK_FREE_RATE) {
    // Daily theta (negative = decay per day)
    if (T <= 0.003 || sigma <= 0) return 0;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI); // pdf
    const theta = -(S * nd1 * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2);
    return theta / 365; // per-day theta
}

// ── Colours ───────────────────────────────────────────────────────────────────
const COLORS = {
    entry:   '#93c5fd', // blue-300
    today:   '#3b82f6', // blue-500
    mid:     '#f59e0b', // amber-500
    sevenD:  '#f97316', // orange-500
    expiry:  '#ef4444', // red-500
    live:    '#10b981', // emerald-500
    capture: 'rgba(16,185,129,0.15)',
};

// ── Tooltip helpers ───────────────────────────────────────────────────────────
const TrajectoryTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-lg p-3 text-xs">
            <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1.5">Stock @ ${Number(label).toFixed(2)}</div>
            {payload.map((p) => (
                <div key={p.name} className="flex justify-between gap-4 mb-0.5">
                    <span style={{ color: p.color }}>{p.name}</span>
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                        ${Number(p.value).toFixed(3)}
                    </span>
                </div>
            ))}
            <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-700 text-slate-400">
                Higher lines = more time value remaining
            </div>
        </div>
    );
};

const ThetaTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const theoretical = payload.find(p => p.name === 'Theoretical (entry IV)');
    const currentIVLine = payload.find(p => p.name === 'Current IV path');
    if (!theoretical) return null;
    return (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-lg p-3 text-xs">
            <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1.5">{label} DTE remaining</div>
            <div className="flex justify-between gap-4 mb-0.5">
                <span className="text-blue-400">Entry IV model</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">${Number(theoretical.value).toFixed(3)}</span>
            </div>
            {currentIVLine && (
                <div className="flex justify-between gap-4 mb-0.5">
                    <span className="text-amber-400">Current IV path</span>
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">${Number(currentIVLine.value).toFixed(3)}</span>
                </div>
            )}
            <div className="text-slate-400 mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-700">
                {label <= 7 ? 'Low DTE — most value already gone, closing may not be worthwhile' :
                 label <= 14 ? 'Approaching the steeper part of the decay curve' :
                 'Significant time value remains'}
            </div>
        </div>
    );
};

// ── Info box ──────────────────────────────────────────────────────────────────
const InfoBox = ({ children }) => (
    <div className="flex gap-2 mt-3 p-3 bg-slate-50 dark:bg-slate-700/40 rounded-lg border border-slate-100 dark:border-slate-700">
        <Info className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{children}</p>
    </div>
);

// ── Main component ────────────────────────────────────────────────────────────
export const CCTrajectoryModal = ({ pos, onClose }) => {
    const [activeTab, setActiveTab] = useState(0);
    const [whatIfIV, setWhatIfIV] = useState(null); // override IV for tab 3

    const cc = pos.cc;
    const K       = cc.strike;
    const entryIV = cc.iv ?? null;          // decimal (e.g. 0.38)
    const entryPremium = cc.entryPrice;
    const entryStockPrice = cc.entryStockPrice ?? null;
    const currentS = pos.stockPrice ?? null;
    const liveOptMid = pos.liveOptionPrice ?? null;
    const currentDTE = pos.dte ?? 0;

    // Entry DTE (full cycle length)
    const entryDTE = useMemo(() => {
        if (!cc.openedDate || !cc.expirationDate) return null;
        return Math.max(1, Math.round(
            (new Date(cc.expirationDate + 'T12:00:00') - new Date(cc.openedDate + 'T12:00:00')) / 86400000
        ));
    }, [cc.openedDate, cc.expirationDate]);

    const hasIV = entryIV != null && entryIV > 0;
    const hasLivePrice = currentS != null;

    // ── Tab 1: Decay Trajectory data ─────────────────────────────────────────
    const trajectoryData = useMemo(() => {
        if (!hasIV) return null;
        const center = K;
        const low  = center * 0.78;
        const high = center * 1.22;
        const step = (high - low) / 60;

        // Which DTE slices to draw
        const slices = [];
        if (entryDTE) slices.push({ dte: entryDTE, label: `Entry (${entryDTE}d)`, color: COLORS.entry });
        if (currentDTE !== entryDTE) slices.push({ dte: currentDTE, label: `Today (${currentDTE}d)`, color: COLORS.today });
        if (currentDTE > 14) slices.push({ dte: 14, label: '14 DTE', color: COLORS.mid });
        if (currentDTE > 7)  slices.push({ dte: 7,  label: '7 DTE',  color: COLORS.sevenD });
        slices.push({ dte: 0, label: 'Expiry', color: COLORS.expiry });

        const rows = [];
        for (let s = low; s <= high + step * 0.5; s += step) {
            const S = +s.toFixed(2);
            const row = { stock: S };
            for (const sl of slices) {
                row[sl.label] = +bsCall(S, K, Math.max(sl.dte, 0.01) / 365, entryIV).toFixed(4);
            }
            rows.push(row);
        }
        return { rows, slices };
    }, [K, entryIV, entryDTE, currentDTE, hasIV]);

    // ── Current IV — back-calculated from live mid (shared by Tab 1 & Tab 2) ──
    const currentIV = useMemo(() => {
        if (!hasIV || !hasLivePrice || liveOptMid == null || liveOptMid <= 0 || currentDTE == null) return null;
        const T = Math.max(currentDTE, 0.01) / 365;
        let lo = 0.01, hi = 5.0;
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            const p   = bsCall(currentS, K, T, mid);
            if (p > liveOptMid) hi = mid;
            else lo = mid;
            if (hi - lo < 0.0001) break;
        }
        return +((lo + hi) / 2).toFixed(4);
    }, [K, currentDTE, currentS, liveOptMid, hasIV, hasLivePrice]);

    // ── Tab 2: Theta Decay data ───────────────────────────────────────────────
    const thetaData = useMemo(() => {
        if (!hasIV || !hasLivePrice) return null;
        const S = currentS;
        const rows = [];
        for (let dte = (entryDTE ?? currentDTE + 5); dte >= 0; dte--) {
            const T   = Math.max(dte, 0.01) / 365;
            const val = +bsCall(S, K, T, entryIV).toFixed(4);
            const th  = +bsTheta(S, K, T, entryIV).toFixed(5);
            const row = { dte, 'Theoretical (entry IV)': val, dailyTheta: th };
            if (currentIV != null) {
                row['Current IV path'] = +bsCall(S, K, T, currentIV).toFixed(4);
            }
            rows.push(row);
        }
        return rows;
    }, [K, entryIV, currentIV, entryDTE, currentDTE, currentS, hasIV, hasLivePrice]);

    // ── Tab 3: IV Context data ────────────────────────────────────────────────
    const ivContext = useMemo(() => {
        if (!hasIV || !hasLivePrice || currentDTE == null) return null;
        const T = Math.max(currentDTE, 0.01) / 365;
        const theoreticalAtEntryIV = +bsCall(currentS, K, T, entryIV).toFixed(4);

        // What-if scenarios
        const ivOverride = whatIfIV ?? entryIV;
        const whatIfVal = +bsCall(currentS, K, T, ivOverride).toFixed(4);

        const ivPoints = [];
        const ivStep = entryIV / 20;
        for (let iv = entryIV; iv >= entryIV * 0.2; iv -= ivStep) {
            ivPoints.push({
                iv: +(iv * 100).toFixed(1),
                value: +bsCall(currentS, K, T, iv).toFixed(4),
            });
        }

        return { theoreticalAtEntryIV, currentIV, whatIfVal, ivPoints, ivOverride };
    }, [K, entryIV, currentIV, currentDTE, currentS, hasIV, hasLivePrice, whatIfIV]);

    // ── Metric bar at top ─────────────────────────────────────────────────────
    const capturePct = liveOptMid != null && entryPremium > 0
        ? +((1 - liveOptMid / entryPremium) * 100).toFixed(1)
        : null;
    const theoretical = (hasIV && hasLivePrice && currentDTE != null)
        ? +bsCall(currentS, K, Math.max(currentDTE, 0.01) / 365, entryIV).toFixed(3)
        : null;
    const ivDeviation = (liveOptMid != null && theoretical != null && theoretical > 0)
        ? +(((liveOptMid - theoretical) / theoretical) * 100).toFixed(1)
        : null;

    const tabs = ['Decay trajectory', 'Theta decay', 'IV context'];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm overflow-y-auto">
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm w-full max-w-2xl my-8">

                {/* Header */}
                <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-slate-50 dark:bg-slate-800/50">
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-bold text-slate-800 dark:text-white">{pos.ticker}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-sm text-slate-600 dark:text-slate-300">${K} call · {cc.expirationDate?.slice(5).replace('-', '/')}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-mono">
                            {currentDTE}d left
                        </span>
                        {!hasIV && (
                            <span className="text-xs text-amber-600 dark:text-amber-400">
                                ⚠ No entry IV — add it via Edit to unlock charts
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Metric strip */}
                <div className="grid grid-cols-4 gap-0 border-b border-slate-100 dark:border-slate-700 text-center">
                    {[
                        { label: 'Entry premium', value: `$${entryPremium.toFixed(2)}`, cls: 'text-slate-700 dark:text-slate-200' },
                        { label: 'Live mid', value: liveOptMid != null ? `$${liveOptMid.toFixed(2)}` : '—', cls: liveOptMid != null ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400' },
                        { label: 'Captured', value: capturePct != null ? `${capturePct}%` : '—', cls: capturePct >= 50 ? 'text-amber-500' : 'text-slate-600 dark:text-slate-300' },
                        { label: 'Theoretical', value: theoretical != null ? `$${theoretical.toFixed(3)}` : '—', cls: ivDeviation != null && ivDeviation < -3 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-300' },
                    ].map((m, i) => (
                        <div key={i} className={`py-3 px-2 text-xs ${i < 3 ? 'border-r border-slate-100 dark:border-slate-700' : ''}`}>
                            <div className="text-slate-400 mb-0.5">{m.label}</div>
                            <div className={`font-mono font-semibold ${m.cls}`}>{m.value}</div>
                        </div>
                    ))}
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-100 dark:border-slate-700">
                    {tabs.map((t, i) => (
                        <button
                            key={t}
                            onClick={() => setActiveTab(i)}
                            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === i
                                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            }`}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                <div className="p-5">

                    {/* ── Tab 0: Decay Trajectory ── */}
                    {activeTab === 0 && (
                        <div>
                            {!hasIV ? (
                                <div className="py-10 text-center text-sm text-slate-400">Add entry IV to the trade to unlock this chart.</div>
                            ) : (
                                <>
                                    {/* Legend */}
                                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-3">
                                        {trajectoryData?.slices.map(sl => (
                                            <div key={sl.label} className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                                <div className="w-5 h-0.5 rounded" style={{ background: sl.color }} />
                                                {sl.label}
                                            </div>
                                        ))}
                                        {hasLivePrice && liveOptMid != null && (
                                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                                <div className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS.live }} />
                                                Live position
                                            </div>
                                        )}
                                        {entryStockPrice != null && (
                                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                                <div className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: COLORS.entry, background: 'transparent' }} />
                                                Entry
                                            </div>
                                        )}
                                    </div>

                                    <ResponsiveContainer width="100%" height={240}>
                                        <LineChart data={trajectoryData?.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                                            <XAxis
                                                dataKey="stock"
                                                tickFormatter={v => `$${v}`}
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                tickCount={7}
                                                type="number"
                                                domain={['dataMin', 'dataMax']}
                                            />
                                            <YAxis
                                                tickFormatter={v => `$${v.toFixed(2)}`}
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                width={48}
                                            />
                                            <Tooltip content={<TrajectoryTooltip />} />
                                            {/* Strike reference line */}
                                            <ReferenceLine x={K} stroke="#6366f1" strokeDasharray="4 3" strokeWidth={1} label={{ value: `Strike $${K}`, position: 'top', fontSize: 10, fill: '#6366f1' }} />
                                            {trajectoryData?.slices.map(sl => (
                                                <Line
                                                    key={sl.label}
                                                    type="monotone"
                                                    dataKey={sl.label}
                                                    stroke={sl.color}
                                                    strokeWidth={sl.label.startsWith('Today') ? 2.5 : 1.5}
                                                    dot={false}
                                                    strokeDasharray={sl.dte === 0 ? '4 3' : sl.dte === 7 || sl.dte === 14 ? '6 3' : undefined}
                                                />
                                            ))}
                                            {/* Live position dot */}
                                            {hasLivePrice && liveOptMid != null && (
                                                <ReferenceDot x={currentS} y={liveOptMid} r={6} fill={COLORS.live} stroke="white" strokeWidth={2} />
                                            )}
                                            {/* Entry dot */}
                                            {entryStockPrice != null && (
                                                <ReferenceDot x={entryStockPrice} y={entryPremium} r={6} fill="transparent" stroke={COLORS.entry} strokeWidth={2} />
                                            )}
                                        </LineChart>
                                    </ResponsiveContainer>

                                    <InfoBox>
                                        Each line shows what the option is theoretically worth at different points in time, holding entry IV constant. The <strong style={{fontWeight:500}}>gap between lines widens</strong> as expiry approaches — that's theta acceleration. The green dot is your live position. When it sits <em>below</em> the today line, IV has compressed since entry (good — option is cheaper to close than the model predicts). When it sits <em>above</em>, IV has expanded.
                                    </InfoBox>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── Tab 1: Theta Decay ── */}
                    {activeTab === 1 && (
                        <div>
                            {!hasIV || !hasLivePrice ? (
                                <div className="py-10 text-center text-sm text-slate-400">
                                    {!hasIV ? 'Add entry IV to the trade to unlock this chart.' : 'Live stock price unavailable.'}
                                </div>
                            ) : (
                                <>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-3">
                                        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                            <div className="w-5 h-0.5 rounded bg-blue-500" />
                                            Entry IV ({entryIV != null ? `${(entryIV*100).toFixed(0)}%` : '—'}) path
                                        </div>
                                        {currentIV != null && (
                                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                                <div className="w-5 h-0.5 rounded" style={{background:'#f59e0b',borderTop:'2px dashed #f59e0b'}} />
                                                Current IV ({(currentIV*100).toFixed(0)}%) path
                                            </div>
                                        )}
                                        {liveOptMid != null && (
                                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                                                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                                                Today (live mid)
                                            </div>
                                        )}
                                    </div>

                                    <ResponsiveContainer width="100%" height={240}>
                                        <AreaChart data={thetaData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                            <defs>
                                                <linearGradient id="captureGrad" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.03} />
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                                            <XAxis
                                                dataKey="dte"
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                tickFormatter={v => `${v}d`}
                                                label={{ value: 'DTE → expiry', position: 'insideBottomRight', offset: -4, fontSize: 10, fill: '#94a3b8' }}
                                            />
                                            <YAxis
                                                tickFormatter={v => `$${v.toFixed(2)}`}
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                width={48}
                                            />
                                            <Tooltip content={<ThetaTooltip />} />
                                            <Area
                                                type="monotone"
                                                dataKey="Theoretical (entry IV)"
                                                stroke={COLORS.today}
                                                strokeWidth={2}
                                                fill="url(#captureGrad)"
                                                dot={false}
                                            />
                                            {currentIV != null && (
                                                <Area
                                                    type="monotone"
                                                    dataKey="Current IV path"
                                                    stroke="#f59e0b"
                                                    strokeWidth={1.5}
                                                    strokeDasharray="5 3"
                                                    fill="none"
                                                    dot={false}
                                                />
                                            )}
                                            {/* Entry dot */}
                                            {entryDTE != null && (
                                                <ReferenceDot
                                                    x={entryDTE}
                                                    y={entryPremium}
                                                    r={6}
                                                    fill="transparent"
                                                    stroke={COLORS.entry}
                                                    strokeWidth={2}
                                                    label={{ value: `Entry $${entryPremium.toFixed(2)}`, position: 'top', fontSize: 10, fill: COLORS.entry }}
                                                />
                                            )}
                                            {/* Today dot */}
                                            {liveOptMid != null && (
                                                <ReferenceDot
                                                    x={currentDTE}
                                                    y={liveOptMid}
                                                    r={6}
                                                    fill={COLORS.live}
                                                    stroke="white"
                                                    strokeWidth={2}
                                                    label={{ value: `$${liveOptMid.toFixed(2)}`, position: 'top', fontSize: 10, fill: COLORS.live }}
                                                />
                                            )}
                                            {/* 50% capture reference */}
                                            <ReferenceLine
                                                y={entryPremium * 0.5}
                                                stroke="#f59e0b"
                                                strokeDasharray="4 3"
                                                strokeWidth={1}
                                                label={{ value: '50% target', position: 'insideRight', fontSize: 10, fill: '#f59e0b' }}
                                            />
                                            {/* 7 DTE zone */}
                                            <ReferenceLine
                                                x={7}
                                                stroke="#ef4444"
                                                strokeDasharray="4 3"
                                                strokeWidth={1}
                                                label={{ value: '7d', position: 'top', fontSize: 10, fill: '#ef4444' }}
                                            />
                                        </AreaChart>
                                    </ResponsiveContainer>

                                    <InfoBox>
                                        The solid blue curve shows the option decaying from entry to zero using your <strong style={{fontWeight:500}}>entry IV as the baseline</strong>. For an out-of-the-money option like this, decay tends to be steeper early in the cycle when there's more time value to shed, then gradually flattens as the option approaches zero near expiry — unlike an ATM option which spikes sharply in the final days. The <strong style={{fontWeight:500}}>dashed amber line</strong> shows the same decay path using today's implied IV: when it sits <em>above</em> the blue line, IV has expanded since entry (option is priced richer — works against you). When it sits <em>below</em>, IV has compressed (a tailwind). The amber horizontal line marks 50% capture; the red line marks 7 DTE.
                                    </InfoBox>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── Tab 2: IV Context ── */}
                    {activeTab === 2 && (
                        <div>
                            {!hasIV || !hasLivePrice ? (
                                <div className="py-10 text-center text-sm text-slate-400">
                                    Add entry IV and ensure live prices are enabled to unlock this tab.
                                </div>
                            ) : (
                                <>
                                    {/* IV comparison bars */}
                                    <div className="grid grid-cols-2 gap-3 mb-4">
                                        <div className="bg-slate-50 dark:bg-slate-700/40 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                                            <div className="text-xs text-slate-400 mb-1">Entry IV (locked)</div>
                                            <div className="text-xl font-semibold font-mono text-blue-500">{(entryIV * 100).toFixed(1)}%</div>
                                            <div className="mt-2 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, entryIV * 200)}%` }} />
                                            </div>
                                            <div className="text-[10px] text-slate-400 mt-1">IV when you sold the call — the baseline for modeling</div>
                                        </div>
                                        <div className="bg-slate-50 dark:bg-slate-700/40 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                                            <div className="text-xs text-slate-400 mb-1">Current IV (implied)</div>
                                            {ivContext?.currentIV != null ? (
                                                <>
                                                    <div className={`text-xl font-semibold font-mono ${ivContext.currentIV < entryIV ? 'text-emerald-500' : 'text-red-500'}`}>
                                                        {(ivContext.currentIV * 100).toFixed(1)}%
                                                        <span className="text-sm ml-1.5 font-normal">
                                                            ({ivContext.currentIV < entryIV ? '−' : '+'}{Math.abs((ivContext.currentIV - entryIV) * 100).toFixed(1)} pts)
                                                        </span>
                                                    </div>
                                                    <div className="mt-2 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full overflow-hidden">
                                                        <div
                                                            className={`h-full rounded-full ${ivContext.currentIV < entryIV ? 'bg-emerald-500' : 'bg-red-500'}`}
                                                            style={{ width: `${Math.min(100, ivContext.currentIV * 200)}%` }}
                                                        />
                                                    </div>
                                                    <div className="text-[10px] text-slate-400 mt-1">
                                                        {ivContext.currentIV < entryIV
                                                            ? 'IV crush — option is cheaper to close than model predicts'
                                                            : 'IV expansion — option is more expensive to close than model predicts'}
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="text-slate-400 text-sm">—  (live mid price unavailable)</div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Model vs actual table */}
                                    <div className="bg-slate-50 dark:bg-slate-700/40 rounded-lg p-3 border border-slate-100 dark:border-slate-700 mb-4">
                                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                                            Model vs market at {currentDTE} DTE · stock ${currentS?.toFixed(2)}
                                        </div>
                                        <table className="w-full text-xs">
                                            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                                                <tr>
                                                    <td className="py-1.5 text-slate-500 dark:text-slate-400">Theoretical (entry IV {(entryIV * 100).toFixed(0)}%)</td>
                                                    <td className="py-1.5 text-right font-mono font-semibold text-slate-700 dark:text-slate-200">${ivContext?.theoreticalAtEntryIV?.toFixed(3)}</td>
                                                </tr>
                                                {liveOptMid != null && (
                                                    <tr>
                                                        <td className="py-1.5 text-slate-500 dark:text-slate-400">Actual market mid</td>
                                                        <td className="py-1.5 text-right font-mono font-semibold text-emerald-600 dark:text-emerald-400">${liveOptMid.toFixed(3)}</td>
                                                    </tr>
                                                )}
                                                {ivDeviation != null && (
                                                    <tr className="border-t border-slate-200 dark:border-slate-600">
                                                        <td className="py-1.5 text-slate-500 dark:text-slate-400">IV deviation</td>
                                                        <td className={`py-1.5 text-right font-mono font-semibold ${ivDeviation < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                                                            {ivDeviation > 0 ? '+' : ''}{ivDeviation}%
                                                            {ivDeviation < -5 && <span className="ml-1 text-[10px] text-emerald-500">← IV crush, consider closing early</span>}
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* What-if IV slider */}
                                    <div className="bg-slate-50 dark:bg-slate-700/40 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                                            What if IV drops to…
                                        </div>
                                        <div className="flex items-center gap-3 mb-2">
                                            <input
                                                type="range"
                                                min={Math.round(entryIV * 20)}
                                                max={Math.round(entryIV * 100)}
                                                step={1}
                                                value={Math.round((whatIfIV ?? entryIV) * 100)}
                                                onChange={e => setWhatIfIV(Number(e.target.value) / 100)}
                                                className="flex-1"
                                            />
                                            <span className="text-sm font-mono font-semibold text-indigo-600 dark:text-indigo-400 min-w-[44px] text-right">
                                                {((whatIfIV ?? entryIV) * 100).toFixed(0)}%
                                            </span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-slate-400">Option would be worth:</span>
                                            <span className={`font-mono font-semibold ${ivContext?.whatIfVal < entryPremium * 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200'}`}>
                                                ${ivContext?.whatIfVal?.toFixed(3)}
                                                {ivContext?.whatIfVal != null && entryPremium > 0 && (
                                                    <span className="text-slate-400 font-normal ml-1">
                                                        ({(((entryPremium - ivContext.whatIfVal) / entryPremium) * 100).toFixed(0)}% captured)
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                    </div>

                                    <InfoBox>
                                        <strong style={{fontWeight:500}}>IV crush</strong> is when market fear drops after you sold the call, making the option cheaper than the model expects at entry IV. That gap between "theoretical" and "actual mid" is pure profit beyond what time alone gives you. The what-if slider lets you model a scenario where IV collapses — if the option would be under 50% of entry premium at a plausible IV level, that's a strong early-close signal even with significant DTE remaining.
                                    </InfoBox>
                                </>
                            )}
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
};
