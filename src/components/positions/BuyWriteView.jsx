import React, { useState, useEffect, useMemo } from 'react';
import {
    RefreshCw, CheckCircle2, RotateCw, Edit2,
    PlusCircle, Layers, AlertTriangle, ChevronRight, ChevronDown, ChevronLeft,
    Ban, FileText, X
} from 'lucide-react';
import { formatCurrency, formatDateShort } from '../../utils/formatters';
import { calculateDTE, calculateMetrics } from '../../utils/calculations';
import { tradesApi, stocksApi } from '../../services/api';

// ============================================================
// TUNABLE CONSTANTS
// ============================================================
const DTE_DANGER        = 7;   // days — red warning
const DTE_WARN          = 14;  // days — orange warning
const PROFIT_TARGET_PCT = 50;  // % of max premium — flag early close opportunity
const DRIFT_RANGE_PCT   = 20;  // % — price vs cost basis bar scale (±)
const STRIKE_RANGE_PCT  = 15;  // % — price vs strike bar scale (±)

// ============================================================
// Score tier config — matches WF40 report cutoffs
// ============================================================
const scoreConfig = (score) => {
    if (score == null || score === '') return null;
    const s = Number(score);
    if (s >= 7.5) return { Icon: CheckCircle2, cls: 'text-emerald-500 dark:text-emerald-400', label: 'FAVORABLE' };
    if (s >= 5.5) return { Icon: AlertTriangle,  cls: 'text-amber-500 dark:text-amber-400',   label: 'MARGINAL'   };
    if (s >= 3.0) return { Icon: Ban,            cls: 'text-orange-500 dark:text-orange-400', label: 'UNFAVORABLE'};
    return             { Icon: Ban,            cls: 'text-red-500 dark:text-red-400',     label: 'REJECT'     };
};

// ============================================================
// Summary Card
// ============================================================
const SummaryCard = ({ label, value, subtext, color = 'slate' }) => {
    const colorMap = {
        slate:  'text-slate-800 dark:text-slate-100',
        green:  'text-emerald-600 dark:text-emerald-400',
        red:    'text-red-500 dark:text-red-400',
        indigo: 'text-indigo-600 dark:text-indigo-400',
        amber:  'text-amber-600 dark:text-amber-400',
    };
    return (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</div>
            <div className={`text-2xl font-bold ${colorMap[color] || colorMap.slate}`}>{value}</div>
            {subtext && <div className="text-xs text-slate-400 mt-1">{subtext}</div>}
        </div>
    );
};

// ============================================================
// CenteredBar — bi-directional bar anchored at center (0%)
//   pct            : deviation value (positive = right, negative = left)
//   range          : max scale (e.g. 20 for ±20%)
//   positiveIsGood : true → right=green/left=red | false → right=red/left=green
// ============================================================
const CenteredBar = ({ pct, range, positiveIsGood = true }) => {
    if (pct == null) return null;
    const clamped    = Math.max(-range, Math.min(range, pct));
    const overLeft   = pct < -range;
    const overRight  = pct >  range;
    const isPositive = pct >= 0;
    const fillWidth  = `${(Math.abs(clamped) / range) * 50}%`;

    const goodCls = 'bg-emerald-400 dark:bg-emerald-500';
    const badCls  = 'bg-red-400 dark:bg-red-500';
    const fillCls = isPositive
        ? (positiveIsGood ? goodCls : badCls)
        : (positiveIsGood ? badCls  : goodCls);
    const leftArrowCls  = positiveIsGood ? 'text-red-400 dark:text-red-500'     : 'text-emerald-400 dark:text-emerald-500';
    const rightArrowCls = positiveIsGood ? 'text-emerald-400 dark:text-emerald-500' : 'text-red-400 dark:text-red-500';

    return (
        <div className="flex items-center gap-0.5 mt-1.5">
            {overLeft
                ? <ChevronLeft  className={`w-2.5 h-2.5 flex-shrink-0 ${leftArrowCls}`}  />
                : <span className="w-2.5 flex-shrink-0" />
            }
            <div className="relative flex-1 h-[3px] bg-slate-100 dark:bg-slate-700 rounded-full">
                {/* Center tick */}
                <div className="absolute top-0 bottom-0 w-px bg-slate-400 dark:bg-slate-500"
                     style={{ left: '50%', transform: 'translateX(-50%)' }} />
                {/* Directional fill */}
                <div
                    className={`absolute top-0 bottom-0 rounded-full ${fillCls}`}
                    style={isPositive
                        ? { left: '50%',  width: fillWidth }
                        : { right: '50%', width: fillWidth }}
                />
            </div>
            {overRight
                ? <ChevronRight className={`w-2.5 h-2.5 flex-shrink-0 ${rightArrowCls}`} />
                : <span className="w-2.5 flex-shrink-0" />
            }
        </div>
    );
};

// ============================================================
// DteBar — depleting countdown bar (full at entry → empty at expiry)
//   Color tracks DTE thresholds: green → amber → red
// ============================================================
const DteBar = ({ dte, openedDate, expirationDate }) => {
    if (dte == null || !openedDate || !expirationDate) return null;
    const totalDays  = Math.max(1, Math.round(
        (new Date(expirationDate + 'T12:00:00') - new Date(openedDate + 'T12:00:00')) / 86400000
    ));
    const remainPct  = Math.max(0, Math.min(100, (dte / totalDays) * 100));
    const colorCls   = dte <= DTE_DANGER ? 'bg-red-500 dark:bg-red-400'
                     : dte <= DTE_WARN   ? 'bg-amber-400 dark:bg-amber-300'
                     :                     'bg-emerald-400 dark:bg-emerald-500';
    return (
        <div className="mt-1.5 h-[3px] bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${colorCls}`} style={{ width: `${remainPct}%` }} />
        </div>
    );
};

// ============================================================
// Capital Card — enriched Deployed Capital with account metrics
// ============================================================
const CapitalCard = ({ deployed, accountValue, activeCount, uncoveredCount }) => {
    const balance     = accountValue > 0 ? accountValue - deployed : null;
    const pctDeployed = accountValue > 0 ? (deployed / accountValue) * 100 : null;
    return (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Deployed Capital</div>
            <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{formatCurrency(deployed)}</div>
            <div className="text-xs text-slate-400 mt-1">{activeCount} active · {uncoveredCount} uncovered</div>
            {accountValue > 0 ? (
                <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700 space-y-1">
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-400">Total Account</span>
                        <span className="font-mono text-slate-600 dark:text-slate-300">{formatCurrency(accountValue)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-400">Available</span>
                        <span className={`font-mono font-semibold ${balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                            {formatCurrency(balance)}
                        </span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-400">% Deployed</span>
                        <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">{pctDeployed.toFixed(1)}%</span>
                    </div>
                </div>
            ) : (
                <div className="text-xs text-slate-400 mt-2">Set account value in Settings to see drawdown</div>
            )}
        </div>
    );
};

// ============================================================
// Status Badge
// ============================================================
const StatusBadge = ({ status }) => {
    const cfg = {
        ACTIVE_CC: { cls: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300', label: 'ACTIVE CC' },
        UNCOVERED: { cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400', label: 'UNCOVERED' },
        CC_ONLY:   { cls: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',   label: 'NO STOCK'  },
    };
    const { cls, label } = cfg[status] || cfg.CC_ONLY;
    return <span className={`px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap ${cls}`}>{label}</span>;
};

// ============================================================
// AnalyticsRow — expandable metrics panel (rendered as a <tr>)
// ============================================================
const AnalyticsRow = ({ analytics, colSpan }) => {
    const a = analytics;
    const fmt2   = (n) => n != null ? n.toFixed(2) : '—';
    const fmtPct = (n) => n != null ? `${n.toFixed(2)}%` : '—';
    const fmtCur = (n) => n != null ? formatCurrency(n) : '—';
    return (
        <tr className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-700">
            <td colSpan={colSpan} className="px-4 py-3">
                <div className="grid grid-cols-3 md:grid-cols-6 gap-x-6 gap-y-2 text-xs">
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">Breakeven</div>
                        <div className="font-mono font-bold text-slate-700 dark:text-slate-200">${fmt2(a.breakeven)}</div>
                        <div className="text-slate-400">{fmtPct(a.downsidePct)} downside cover</div>
                    </div>
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">Premium ROI</div>
                        <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{fmtPct(a.premiumROI)}</div>
                        <div className="text-slate-400">this cycle</div>
                    </div>
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">Ann. ROC</div>
                        <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{fmtPct(a.annualizedROC)}</div>
                        <div className="text-slate-400">annualized</div>
                    </div>
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">If Called</div>
                        <div className={`font-mono font-bold ${a.ifCalledRetPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                            {fmtPct(a.ifCalledRetPct)}
                        </div>
                        <div className="text-slate-400">stock + prem</div>
                    </div>
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">Max Profit</div>
                        <div className="font-mono font-bold text-slate-700 dark:text-slate-200">{fmtCur(a.maxProfit)}</div>
                        <div className="text-slate-400">if called away</div>
                    </div>
                    <div>
                        <div className="text-slate-400 uppercase tracking-wide font-semibold mb-0.5">% of Account</div>
                        {a.pctOfAccount != null ? (
                            <>
                                <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{fmtPct(a.pctOfAccount)}</div>
                                <div className="text-slate-400">capital deployed</div>
                            </>
                        ) : (
                            <>
                                <div className="font-mono text-slate-400">—</div>
                                <div className="text-slate-400">set acct value in settings</div>
                            </>
                        )}
                    </div>
                </div>
            </td>
        </tr>
    );
};

// ============================================================
// BuyWriteView — Main Component
// ============================================================
export const BuyWriteView = ({
    accountId,
    accountValue,       // total account size in dollars — used for % of account calc
    livePricesEnabled,
    onRoll,
    onEdit,
    onExpire,
    onNewTrade,
}) => {
    const [ccTrades,        setCcTrades]        = useState([]);
    const [stocks,          setStocks]          = useState([]);
    const [prices,          setPrices]          = useState({});
    const [optionPrices,    setOptionPrices]    = useState({});
    const [loading,         setLoading]         = useState(true);
    const [refreshing,      setRefreshing]      = useState(false);
    const [expandedTickers, setExpandedTickers] = useState(new Set());
    const [notesPopup,     setNotesPopup]     = useState({ open: false, tradeId: null, ticker: '', notes: '' });
    const [savingNotes,    setSavingNotes]    = useState(false);

    const openNotesPopup = (cc, ticker) => {
        setNotesPopup({ open: true, tradeId: cc.id, ticker, notes: cc.notes || '' });
    };

    const closeNotesPopup = () => {
        setNotesPopup({ open: false, tradeId: null, ticker: '', notes: '' });
    };

    const saveNotes = async () => {
        setSavingNotes(true);
        try {
            await tradesApi.update(notesPopup.tradeId, { notes: notesPopup.notes });
            setCcTrades(prev => prev.map(t =>
                t.id === notesPopup.tradeId ? { ...t, notes: notesPopup.notes } : t
            ));
            closeNotesPopup();
        } catch (err) {
            console.error('Failed to save notes:', err);
        } finally {
            setSavingNotes(false);
        }
    };

    const toggleExpanded = (ticker) => {
        setExpandedTickers(prev => {
            const next = new Set(prev);
            next.has(ticker) ? next.delete(ticker) : next.add(ticker);
            return next;
        });
    };

    // ----------------------------------------------------------
    // Fetch trades + stocks
    // ----------------------------------------------------------
    const fetchData = async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true);
        try {
            const tradeParams = { status: 'Open', ...(accountId && { accountId }) };
            const stockParams = { ...(accountId && { accountId }) };
            const [tradesRes, stocksRes] = await Promise.all([
                tradesApi.getAll(tradeParams),
                stocksApi.getAll(stockParams),
            ]);
            if (tradesRes.success) setCcTrades(tradesRes.data.filter(t => t.type === 'CC'));
            if (stocksRes.success) setStocks(stocksRes.data.filter(s => !s.soldDate));
        } catch (err) {
            console.error('BuyWriteView fetch error:', err);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => { fetchData(); }, [accountId]);

    // ----------------------------------------------------------
    // Live prices
    // ----------------------------------------------------------
    useEffect(() => {
        if (!livePricesEnabled) { setPrices({}); setOptionPrices({}); return; }

        const tickers = [...new Set([
            ...ccTrades.map(t => t.ticker.toUpperCase()),
            ...stocks.map(s => s.ticker.toUpperCase()),
        ])];

        if (tickers.length > 0) {
            fetch('/api/prices/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickers }),
            }).then(r => r.json()).then(d => { if (d.success) setPrices(d.data); }).catch(() => {});
        }

        if (ccTrades.length > 0) {
            const contracts = ccTrades.map(t => ({
                ticker: t.ticker.toUpperCase(),
                strike: t.strike,
                expirationDate: t.expirationDate,
                type: t.type,
            }));
            fetch('/api/prices/options/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contracts }),
            }).then(r => r.json()).then(d => { if (d.success) setOptionPrices(d.data); }).catch(() => {});
        }
    }, [livePricesEnabled, ccTrades, stocks]);

    // ----------------------------------------------------------
    // Build combined positions (join stocks + CC trades by ticker)
    // ----------------------------------------------------------
    const positions = useMemo(() => {
        // Index stocks by ticker
        const stockByTicker = {};
        for (const s of stocks) {
            const t = s.ticker.toUpperCase();
            if (!stockByTicker[t]) stockByTicker[t] = [];
            stockByTicker[t].push(s);
        }

        // Index CC trades by ticker — most recent open CC wins
        const ccByTicker = {};
        for (const t of ccTrades) {
            const ticker = t.ticker.toUpperCase();
            const existing = ccByTicker[ticker];
            if (!existing || new Date(t.openedDate + 'T12:00:00') > new Date(existing.openedDate + 'T12:00:00')) {
                ccByTicker[ticker] = t;
            }
        }

        const allTickers = new Set([...Object.keys(stockByTicker), ...Object.keys(ccByTicker)]);
        const result = [];

        for (const ticker of allTickers) {
            const stockRecords = stockByTicker[ticker] || [];
            const cc = ccByTicker[ticker] || null;

            // Aggregate stock lots (FIFO cost basis weighted average)
            const totalShares = stockRecords.reduce((s, r) => s + (parseFloat(r.shares) || 0), 0);
            const avgCostBasis = totalShares > 0
                ? stockRecords.reduce((s, r) => s + (parseFloat(r.costBasis) || 0) * (parseFloat(r.shares) || 0), 0) / totalShares
                : null;

            const stockPrice    = prices[ticker]?.price ?? null;
            const stockPnl      = (stockPrice != null && avgCostBasis != null && totalShares > 0)
                                    ? (stockPrice - avgCostBasis) * totalShares
                                    : null;

            // Options leg
            let optionMetrics = null, liveOptionPrice = null, optionsPnl = null, profitPct = null;
            if (cc) {
                const optionKey  = `${ticker}:${cc.strike}:${cc.expirationDate}:${cc.type}`;
                liveOptionPrice  = optionPrices[optionKey]?.price ?? null;
                optionMetrics    = calculateMetrics(cc, liveOptionPrice);
                optionsPnl       = optionMetrics.pnl;
                profitPct        = optionMetrics.maxProfitPercent;
            }

            const totalPnl = (stockPnl != null || optionsPnl != null)
                ? (stockPnl ?? 0) + (optionsPnl ?? 0)
                : null;

            // ITM / OTM
            let itmOtm = null, itmOtmPct = null;
            if (cc && stockPrice != null) {
                itmOtmPct = ((stockPrice - cc.strike) / cc.strike) * 100;
                itmOtm    = stockPrice >= cc.strike ? 'ITM' : 'OTM';
            }

            const dte = cc ? calculateDTE(cc.expirationDate, 'Open') : null;

            const status = stockRecords.length > 0 && cc ? 'ACTIVE_CC'
                         : stockRecords.length > 0       ? 'UNCOVERED'
                         :                                 'CC_ONLY';

            const deployedCapital = avgCostBasis != null
                ? avgCostBasis * totalShares
                : (cc ? cc.strike * (cc.quantity || 1) * 100 : 0);

            // ── Analytics (for expandable row) ──
            let analytics = null;
            if (cc && avgCostBasis != null && avgCostBasis > 0) {
                const premium       = cc.entryPrice;                                        // per-share premium
                const strike        = cc.strike;
                const breakeven     = avgCostBasis - premium;                              // stock price at which you break even
                const downsidePct   = (premium / avgCostBasis) * 100;                     // % downside protection
                const premiumROI    = (premium / avgCostBasis) * 100;                     // same value, named for context
                // Annualized: use full cycle days (entry → expiry), not remaining DTE
                const openedMs      = new Date(cc.openedDate + 'T12:00:00').getTime();
                const expiryMs      = new Date(cc.expirationDate + 'T12:00:00').getTime();
                const cycleDays     = Math.max(1, Math.round((expiryMs - openedMs) / 86400000));
                const annualizedROC = premiumROI * (365 / cycleDays);
                // If-called: stock gain to strike + premium, as % of cost basis
                const ifCalledRetPct = ((strike - avgCostBasis + premium) / avgCostBasis) * 100;
                const maxProfit      = (strike - avgCostBasis + premium) * (totalShares || (cc.quantity || 1) * 100);
                // % of account (only if accountValue prop is provided and > 0)
                const pctOfAccount  = (accountValue && accountValue > 0)
                    ? (deployedCapital / accountValue) * 100
                    : null;
                analytics = { breakeven, downsidePct, premiumROI, annualizedROC, ifCalledRetPct, maxProfit, pctOfAccount };
            }

            result.push({
                ticker, stockRecords, totalShares, avgCostBasis,
                stockPrice, stockPnl, cc, liveOptionPrice,
                optionMetrics, optionsPnl, totalPnl,
                itmOtm, itmOtmPct, dte, status, profitPct, deployedCapital, analytics,
            });
        }

        // Sort: ACTIVE_CC → UNCOVERED → CC_ONLY → alpha within each group
        const order = { ACTIVE_CC: 0, UNCOVERED: 1, CC_ONLY: 2 };
        result.sort((a, b) => {
            const d = (order[a.status] ?? 3) - (order[b.status] ?? 3);
            return d !== 0 ? d : a.ticker.localeCompare(b.ticker);
        });

        return result;
    }, [ccTrades, stocks, prices, optionPrices]);

    // ----------------------------------------------------------
    // Totals
    // ----------------------------------------------------------
    const totals = useMemo(() => ({
        deployed:         positions.reduce((s, p) => s + (p.deployedCapital || 0), 0),
        stockPnl:         positions.reduce((s, p) => s + (p.stockPnl    ?? 0), 0),
        optionsPnl:       positions.reduce((s, p) => s + (p.optionsPnl  ?? 0), 0),
        totalPnl:         positions.reduce((s, p) => s + (p.totalPnl    ?? 0), 0),
        totalShares:      positions.reduce((s, p) => s + p.totalShares, 0),
        premiumCollected: positions.reduce((s, p) => s + (p.cc ? p.cc.entryPrice * (p.cc.quantity || 1) * 100 : 0), 0),
    }), [positions]);

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------
    const dteColor = (dte) => {
        if (dte == null)        return 'text-slate-400';
        if (dte <= DTE_DANGER)  return 'text-red-600 dark:text-red-400 font-bold';
        if (dte <= DTE_WARN)    return 'text-orange-500 dark:text-orange-400';
        return 'text-slate-600 dark:text-slate-300';
    };

    const pnlColor = (val) =>
        val == null ? 'text-slate-400'
        : val >= 0  ? 'text-emerald-600 dark:text-emerald-400'
        :             'text-red-500 dark:text-red-400';

    // ----------------------------------------------------------
    // Render
    // ----------------------------------------------------------
    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-slate-400">
                <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                Loading positions...
            </div>
        );
    }

    return (
        <div className="space-y-4">

            {/* ── Summary Cards ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <CapitalCard
                    deployed={totals.deployed}
                    accountValue={accountValue}
                    activeCount={positions.filter(p => p.status === 'ACTIVE_CC').length}
                    uncoveredCount={positions.filter(p => p.status === 'UNCOVERED').length}
                />
                <SummaryCard
                    label="Stock P/L"
                    value={formatCurrency(totals.stockPnl)}
                    subtext="Unrealized on shares"
                    color={totals.stockPnl >= 0 ? 'green' : 'red'}
                />
                <SummaryCard
                    label="Premium Captured"
                    value={formatCurrency(totals.optionsPnl)}
                    subtext={`of ${formatCurrency(totals.premiumCollected)} collected`}
                    color={totals.optionsPnl >= 0 ? 'green' : 'red'}
                />
                <SummaryCard
                    label="Total P/L"
                    value={formatCurrency(totals.totalPnl)}
                    subtext="Stock + options combined"
                    color={totals.totalPnl >= 0 ? 'green' : 'red'}
                />
            </div>

            {/* ── Table ── */}
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">

                {/* Header bar */}
                <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
                    <h3 className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
                        <Layers className="w-4 h-4 text-slate-400" />
                        Buy-Write Positions
                        <span className="text-xs font-normal text-slate-400 font-mono bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded">
                            {positions.length} position{positions.length !== 1 ? 's' : ''}
                        </span>
                    </h3>
                    <button
                        onClick={() => fetchData(true)}
                        disabled={refreshing}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg transition-colors border border-slate-200 dark:border-slate-600 ${refreshing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                </div>

                {positions.length === 0 ? (
                    <div className="py-16 text-center text-sm text-slate-400">
                        No positions yet. Add a stock record and a covered call trade to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-slate-500 dark:text-slate-400 uppercase bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700">
                                <tr>
                                    {/* Identity */}
                                    <th className="px-3 py-2.5 font-semibold">Ticker</th>
                                    <th className="px-3 py-2.5 font-semibold text-center">Status</th>

                                    {/* Stock leg — subtle gray tint */}
                                    <th className="px-3 py-2.5 font-semibold text-right border-l-2 border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/60">Shares</th>
                                    <th className="px-3 py-2.5 font-semibold text-right bg-slate-50 dark:bg-slate-800/60">Cost Basis</th>
                                    <th className="px-3 py-2.5 font-semibold text-right bg-slate-50 dark:bg-slate-800/60">Price</th>
                                    <th className="px-3 py-2.5 font-semibold text-right bg-slate-50 dark:bg-slate-800/60">Stock P/L</th>

                                    {/* CC leg — subtle indigo tint */}
                                    <th className="px-3 py-2.5 font-semibold text-center border-l-2 border-indigo-200 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-900/10">Strike</th>
                                    <th className="px-3 py-2.5 font-semibold text-center bg-indigo-50/60 dark:bg-indigo-900/10">Expiry</th>
                                    <th className="px-3 py-2.5 font-semibold text-center bg-indigo-50/60 dark:bg-indigo-900/10">DTE</th>
                                    <th className="px-3 py-2.5 font-semibold text-center bg-indigo-50/60 dark:bg-indigo-900/10">ITM / OTM</th>
                                    <th className="px-3 py-2.5 font-semibold text-right bg-indigo-50/60 dark:bg-indigo-900/10">Premium</th>
                                    <th className="px-3 py-2.5 font-semibold text-right bg-indigo-50/60 dark:bg-indigo-900/10">Opt P/L</th>

                                    {/* Combined */}
                                    <th className="px-3 py-2.5 font-semibold text-right border-l-2 border-slate-300 dark:border-slate-500">Total P/L</th>
                                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>

                            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                                {positions.map((pos) => (
                                    <React.Fragment key={pos.ticker}>
                                    <tr
                                        className={`transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-700/40 ${
                                            pos.status === 'UNCOVERED' ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''
                                        }`}
                                    >
                                        {/* Ticker */}
                                        <td className="px-3 py-3 font-bold text-slate-800 dark:text-white text-sm tracking-wide">
                                            <div className="flex items-center gap-1">
                                                {pos.analytics && (
                                                    <button
                                                        onClick={() => toggleExpanded(pos.ticker)}
                                                        className="text-slate-400 hover:text-indigo-500 transition-colors"
                                                        title="Show analytics"
                                                    >
                                                        {expandedTickers.has(pos.ticker)
                                                            ? <ChevronDown className="w-3.5 h-3.5" />
                                                            : <ChevronRight className="w-3.5 h-3.5" />
                                                        }
                                                    </button>
                                                )}
                                                {pos.ticker}
                                                {pos.status === 'UNCOVERED' && (
                                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                                )}
                                            </div>
                                            {(() => {
                                                const cfg = scoreConfig(pos.cc?.score);
                                                const hasScore = cfg != null;
                                                const hasNotes = !!pos.cc?.notes;
                                                if (!hasScore && !hasNotes) return null;
                                                return (
                                                    <div className="flex items-center gap-1 mt-0.5">
                                                        {hasScore && (
                                                            <>
                                                                <cfg.Icon className={`w-3 h-3 ${cfg.cls}`} title={cfg.label} />
                                                                <span className={`text-xs font-semibold font-mono ${cfg.cls}`}>
                                                                    {Number(pos.cc.score).toFixed(1)}
                                                                </span>
                                                            </>
                                                        )}
                                                        {hasNotes && (
                                                            <button
                                                                onClick={() => openNotesPopup(pos.cc, pos.ticker)}
                                                                className="text-slate-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors ml-0.5"
                                                                title="View / edit notes"
                                                            >
                                                                <FileText className="w-3 h-3" />
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                        </td>

                                        {/* Status */}
                                        <td className="px-3 py-3 text-center">
                                            <StatusBadge status={pos.status} />
                                        </td>

                                        {/* ── STOCK LEG ── */}
                                        <td className="px-3 py-3 text-right font-mono text-sm text-slate-600 dark:text-slate-300 border-l-2 border-slate-200 dark:border-slate-600 bg-slate-50/40 dark:bg-slate-800/20">
                                            {pos.totalShares > 0 ? pos.totalShares : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-sm text-slate-600 dark:text-slate-300 bg-slate-50/40 dark:bg-slate-800/20">
                                            {pos.avgCostBasis != null ? `$${pos.avgCostBasis.toFixed(2)}` : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-sm bg-slate-50/40 dark:bg-slate-800/20">
                                            {pos.stockPrice != null ? (
                                                <span className={pos.stockPrice >= (pos.avgCostBasis ?? 0) ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}>
                                                    ${pos.stockPrice.toFixed(2)}
                                                </span>
                                            ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                            {pos.stockPrice != null && pos.avgCostBasis != null && pos.avgCostBasis > 0 && (
                                                <CenteredBar
                                                    pct={(pos.stockPrice - pos.avgCostBasis) / pos.avgCostBasis * 100}
                                                    range={DRIFT_RANGE_PCT}
                                                    positiveIsGood={true}
                                                />
                                            )}
                                        </td>
                                        <td className={`px-3 py-3 text-right font-mono text-sm font-semibold bg-slate-50/40 dark:bg-slate-800/20 ${pnlColor(pos.stockPnl)}`}>
                                            {pos.stockPnl != null ? formatCurrency(pos.stockPnl) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>

                                        {/* ── CC LEG ── */}
                                        <td className="px-3 py-3 text-center font-mono text-sm text-slate-700 dark:text-slate-200 border-l-2 border-indigo-200 dark:border-indigo-700 bg-indigo-50/30 dark:bg-indigo-900/5">
                                            {pos.cc ? `$${pos.cc.strike}` : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>
                                        <td className="px-3 py-3 text-center text-sm text-slate-500 dark:text-slate-400 bg-indigo-50/30 dark:bg-indigo-900/5 whitespace-nowrap">
                                            {pos.cc ? formatDateShort(pos.cc.expirationDate) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>
                                        <td className={`px-3 py-3 text-center font-mono text-sm bg-indigo-50/30 dark:bg-indigo-900/5 ${dteColor(pos.dte)}`}>
                                            {pos.dte != null ? `${pos.dte}d` : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                            {pos.cc && pos.dte != null && (
                                                <DteBar
                                                    dte={pos.dte}
                                                    openedDate={pos.cc.openedDate}
                                                    expirationDate={pos.cc.expirationDate}
                                                />
                                            )}
                                        </td>
                                        <td className="px-3 py-3 text-center bg-indigo-50/30 dark:bg-indigo-900/5">
                                            {pos.itmOtm ? (
                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                                                    pos.itmOtm === 'ITM'
                                                        ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                                                        : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                                                }`}>
                                                    {pos.itmOtm} {Math.abs(pos.itmOtmPct).toFixed(1)}%
                                                </span>
                                            ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                            {pos.itmOtmPct != null && (
                                                <CenteredBar
                                                    pct={pos.itmOtmPct}
                                                    range={STRIKE_RANGE_PCT}
                                                    positiveIsGood={false}
                                                />
                                            )}
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-sm bg-indigo-50/30 dark:bg-indigo-900/5">
                                            {pos.cc ? (
                                                <div>
                                                    <div className="text-slate-700 dark:text-slate-200">${pos.cc.entryPrice.toFixed(2)}</div>
                                                    {pos.liveOptionPrice != null && (
                                                        <div className={`text-xs ${pos.liveOptionPrice <= pos.cc.entryPrice ? 'text-emerald-500' : 'text-red-400'}`}>
                                                            → ${pos.liveOptionPrice.toFixed(2)}
                                                        </div>
                                                    )}
                                                    {pos.profitPct != null && pos.profitPct >= PROFIT_TARGET_PCT && (
                                                        <div className="text-xs text-amber-500 font-bold">50%+ ✓ close?</div>
                                                    )}
                                                </div>
                                            ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>
                                        <td className={`px-3 py-3 text-right font-mono text-sm font-semibold bg-indigo-50/30 dark:bg-indigo-900/5 ${pnlColor(pos.optionsPnl)}`}>
                                            {pos.optionsPnl != null ? formatCurrency(pos.optionsPnl) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>

                                        {/* ── TOTAL ── */}
                                        <td className={`px-3 py-3 text-right font-mono text-sm font-bold border-l-2 border-slate-300 dark:border-slate-500 ${pnlColor(pos.totalPnl)}`}>
                                            {pos.totalPnl != null ? formatCurrency(pos.totalPnl) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                                        </td>

                                        {/* Actions */}
                                        <td className="px-3 py-3 text-right">
                                            <div className="flex justify-end gap-1 flex-nowrap">
                                                {pos.status === 'UNCOVERED' && (
                                                    <button
                                                        onClick={() => onNewTrade && onNewTrade()}
                                                        title={`Sell a CC on ${pos.ticker}`}
                                                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded transition-colors"
                                                    >
                                                        <PlusCircle className="w-3.5 h-3.5" />
                                                        New CC
                                                    </button>
                                                )}
                                                {pos.cc && pos.status === 'ACTIVE_CC' && (
                                                    <>
                                                        <button
                                                            onClick={() => onExpire && onExpire(pos.cc)}
                                                            title="Mark expired worthless"
                                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded transition-colors"
                                                        >
                                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                                            Expire
                                                        </button>
                                                        <button
                                                            onClick={() => onRoll && onRoll(pos.cc)}
                                                            title="Roll to new expiration"
                                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded transition-colors"
                                                        >
                                                            <RotateCw className="w-3.5 h-3.5" />
                                                            Roll
                                                        </button>
                                                    </>
                                                )}
                                                {pos.cc && (
                                                    <button
                                                        onClick={() => onEdit && onEdit(pos.cc)}
                                                        title="Edit trade"
                                                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded transition-colors"
                                                    >
                                                        <Edit2 className="w-3.5 h-3.5" />
                                                        Edit
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>

                                    {/* ── Analytics Expansion Row ── */}
                                    {expandedTickers.has(pos.ticker) && pos.analytics && (
                                        <AnalyticsRow analytics={pos.analytics} colSpan={15} />
                                    )}
                                    </React.Fragment>
                                ))}

                                {/* ── Totals Row ── */}
                                <tr className="bg-slate-100 dark:bg-slate-700/60 border-t-2 border-slate-300 dark:border-slate-500">
                                    <td className="px-3 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider" colSpan={2}>
                                        Totals
                                    </td>
                                    <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-slate-500 dark:text-slate-400 border-l-2 border-slate-200 dark:border-slate-600">
                                        {totals.totalShares} sh
                                    </td>
                                    <td className="px-3 py-3 text-right font-mono text-xs text-slate-400">
                                        {formatCurrency(totals.deployed)}
                                    </td>
                                    <td className="px-3 py-3"></td>
                                    <td className={`px-3 py-3 text-right font-mono text-sm font-bold ${pnlColor(totals.stockPnl)}`}>
                                        {formatCurrency(totals.stockPnl)}
                                    </td>
                                    <td className="px-3 py-3 border-l-2 border-indigo-200 dark:border-indigo-700" colSpan={4}></td>
                                    <td className="px-3 py-3 text-right font-mono text-xs text-slate-400">
                                        {formatCurrency(totals.premiumCollected)} coll.
                                    </td>
                                    <td className={`px-3 py-3 text-right font-mono text-sm font-bold ${pnlColor(totals.optionsPnl)}`}>
                                        {formatCurrency(totals.optionsPnl)}
                                    </td>
                                    <td className={`px-3 py-3 text-right font-mono text-base font-bold border-l-2 border-slate-300 dark:border-slate-500 ${pnlColor(totals.totalPnl)}`}>
                                        {formatCurrency(totals.totalPnl)}
                                    </td>
                                    <td className="px-3 py-3"></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ── Notes Popup ── */}
            {notesPopup.open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-lg w-full max-w-lg">
                        <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                            <h3 className="font-semibold text-slate-800 dark:text-white">
                                {notesPopup.ticker} — Notes
                            </h3>
                            <button
                                onClick={closeNotesPopup}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="p-4">
                            <textarea
                                className="w-full h-56 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-white resize-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={notesPopup.notes}
                                onChange={(e) => setNotesPopup(prev => ({ ...prev, notes: e.target.value }))}
                                placeholder="Paste AI analysis, trade rationale, notes..."
                            />
                        </div>
                        <div className="p-4 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-2">
                            <button
                                onClick={closeNotesPopup}
                                className="px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={saveNotes}
                                disabled={savingNotes}
                                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
                            >
                                {savingNotes ? 'Saving…' : 'Save Notes'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};
