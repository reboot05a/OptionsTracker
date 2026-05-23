/**
 * ProspectsTab.jsx
 *
 * Displays cc_daily_candidates as a live monitoring dashboard, ported from
 * cc_dashboard.html into React.  Visual design preserved intentionally —
 * monospace/dark-terminal aesthetic distinct from the rest of ROA.
 *
 * Props:
 *   onEntered(candidate)  — called when user clicks ✓ Entered; opens TradeModal
 *   selectedAccountId     — passed through to onEntered for account pre-fill
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API_URL } from '../utils/constants';
import { TickerModal } from './TickerModal';

// ── Formatting helpers ──────────────────────────────────────────────────────
const f2  = v => v != null ? Number(v).toFixed(2) : '—';
const pct = v => v != null ? Number(v).toFixed(1) + '%' : '—';
const d3  = v => v != null ? Number(v).toFixed(3) : '—';

function marketDaysAgo(dateStr) {
    if (!dateStr) return 0;
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr + 'T00:00:00');
    if (target >= today) return 0;
    let count = 0;
    const d = new Date(target);
    while (d < today) {
        d.setDate(d.getDate() + 1);
        const w = d.getDay();
        if (w !== 0 && w !== 6) count++;
    }
    return count;
}

function badgeKey(c) {
    if (c.paused) return 'PAUSED';
    const s = (c.status || '').toUpperCase();
    if (s && s !== 'PENDING') return s;
    return (c.overall_status || 'NO_DATA').toUpperCase();
}

function priceClass(live, ceil) {
    if (live == null || ceil == null) return 'def';
    const r = live / ceil;
    if (r > 1.0)  return 'bad';
    if (r > 0.98) return 'warn';
    return 'ok';
}

function callMidClass(mid, floor) {
    if (mid == null || floor == null) return 'def';
    const r = mid / floor;
    if (r < 1.0)  return 'bad';
    if (r < 1.02) return 'warn';
    return 'ok';
}

function floorClass(mid, floor) {
    if (mid == null || floor == null) return 'def';
    if (mid < floor)          return 'bad';
    if (mid / floor < 1.02)   return 'warn';
    return 'ok';
}

// ── Main component ──────────────────────────────────────────────────────────
export function ProspectsTab({ onEntered, selectedAccountId }) {
    const [data, setData]       = useState(null);   // { run_date, candidates }
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState('');
    const [lastUpdated, setLastUpdated] = useState('');

    // Narrative-open state (Set of tickers) — main card expansion removed
    const [narrCards, setNarrCards] = useState(new Set());

    // Ticker chart modal
    const [chartModal, setChartModal] = useState({ open: false, ticker: null, prospect: null });
    const openChart  = useCallback((c) => setChartModal({ open: true, ticker: c.ticker, prospect: c }), []);
    const closeChart = useCallback(()  => setChartModal({ open: false, ticker: null, prospect: null }), []);

    // Poll progress bar
    const [polling, setPolling]       = useState(false);
    const [pollSecs, setPollSecs]     = useState(75);
    const pollTimerRef  = useRef(null);
    const pollCDRef     = useRef(null);

    // ── Data loading ──────────────────────────────────────────────────────
    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res  = await fetch(`${API_URL}/prospects`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message || 'Unknown error');
            setData(json.data);
            setLastUpdated(
                new Date().toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    timeZone: 'America/New_York',
                }) + ' ET'
            );
        } catch (e) {
            setError(`Load failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // ── Status write ──────────────────────────────────────────────────────
    const setStatus = useCallback(async (ticker, runDate, payload) => {
        try {
            const res = await fetch(`${API_URL}/prospects/status`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ ticker, date: runDate, ...payload }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.message || `HTTP ${res.status}`);
            }
            await load();
        } catch (e) {
            setError(`Update failed: ${e.message}`);
        }
    }, [load]);

    // ── Poll trigger ──────────────────────────────────────────────────────
    const poll = useCallback(async () => {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        if (pollCDRef.current)    clearInterval(pollCDRef.current);
        setPolling(true);
        setPollSecs(75);
        setError('');

        try {
            const res = await fetch(`${API_URL}/prospects/poll`, {
                method: 'POST',
                signal: AbortSignal.timeout(40000),
            });
            if (res.status === 200) {
                setPolling(false);
                await load();
                return;
            }
            if (res.status !== 202 && !res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error?.message || d.message || `HTTP ${res.status}`);
            }
            // 202 — start countdown
            let secs = 75;
            pollCDRef.current = setInterval(() => {
                secs--;
                if (secs <= 0) { clearInterval(pollCDRef.current); return; }
                setPollSecs(secs);
            }, 1000);
            pollTimerRef.current = setTimeout(async () => {
                clearInterval(pollCDRef.current);
                setPolling(false);
                await load();
            }, 75000);
        } catch (e) {
            setPolling(false);
            setError(`Poll failed: ${e.message}`);
        }
    }, [load]);

    // ── Narrative toggle ──────────────────────────────────────────────────
    const toggleNarr = useCallback((ticker, e) => {
        e.stopPropagation();
        setNarrCards(prev => {
            const next = new Set(prev);
            next.has(ticker) ? next.delete(ticker) : next.add(ticker);
            return next;
        });
    }, []);

    // ── Derived run-date state ────────────────────────────────────────────
    // Normalize run_date — Postgres TIMESTAMP columns arrive as ISO strings
    // like "2026-05-21T00:00:00.000Z"; slice to just the date portion.
    const runDate  = data?.run_date ? String(data.run_date).slice(0, 10) : null;
    const mda      = marketDaysAgo(runDate);
    const isStale  = mda > 2;
    const candidates = data?.candidates ?? [];

    const stats = { total: candidates.length, GO: 0, WATCH: 0, BROKEN: 0 };
    candidates.forEach(c => {
        if (!c.paused && stats[c.overall_status] !== undefined) stats[c.overall_status]++;
    });

    const fmtRunDate = runDate
        ? new Date(runDate + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          })
        : '—';
    const ageLabel = mda === 0 ? '— Today'
                   : mda === 1 ? '— Yesterday'
                   : isStale   ? `— ${mda} market days old`
                   : '— 2 market days ago';

    // ── Entered handler ───────────────────────────────────────────────────
    const handleEntered = useCallback((e, candidate) => {
        e.stopPropagation();
        if (onEntered) onEntered(candidate, selectedAccountId);
    }, [onEntered, selectedAccountId]);

    // ── Render ────────────────────────────────────────────────────────────
    return (
        <>
            {/* Scoped CSS — preserves cc_dashboard visual identity */}
            <style>{`
                .pt-root { font-family: 'IBM Plex Mono', 'Courier New', monospace; }
                .pt-root * { box-sizing: border-box; }

                /* ── CSS vars ── */
                .pt-root {
                    --pt-bg:      #0d0f12;
                    --pt-surface: #13161b;
                    --pt-border:  #1f2530;
                    --pt-border2: #2a3342;
                    --pt-text:    #f0f4ff;
                    --pt-sub:     #b8c8d8;
                    --pt-muted:   #7a8fa8;
                    --pt-go:      #1fdf7f;
                    --pt-watch:   #f5a623;
                    --pt-broken:  #f04040;
                    --pt-paused:  #6a7a8a;
                    --pt-entered: #00aaff;
                    --pt-fav:     #00aaff;
                    --pt-mar:     #f5a623;
                }

                /* ── Outer shell ── */
                .pt-shell {
                    background: var(--pt-bg);
                    color: var(--pt-text);
                    font-size: 13px;
                    line-height: 1;
                    border-radius: 8px;
                    overflow: hidden;
                    min-height: 200px;
                }

                /* ── Toolbar ── */
                .pt-toolbar {
                    background: var(--pt-surface);
                    border-bottom: 1px solid var(--pt-border);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0 20px;
                    height: 46px;
                    gap: 12px;
                }
                .pt-toolbar-left  { display: flex; align-items: center; gap: 14px; }
                .pt-toolbar-right { display: flex; align-items: center; gap: 10px; }
                .pt-logo {
                    font-size: 13px; font-weight: 600; letter-spacing: .14em;
                    color: var(--pt-go); text-transform: uppercase;
                }
                .pt-run-label { font-size: 13px; color: var(--pt-sub); letter-spacing: .05em; }
                .pt-updated   { font-size: 12px; color: var(--pt-sub); }
                .pt-btn {
                    font-family: inherit; font-size: 10px; font-weight: 600;
                    letter-spacing: .08em; text-transform: uppercase;
                    padding: 6px 16px; border-radius: 3px;
                    border: 1px solid var(--pt-border2); background: transparent;
                    color: var(--pt-sub); cursor: pointer; transition: all .15s;
                    white-space: nowrap;
                }
                .pt-btn:hover              { color: var(--pt-text); border-color: var(--pt-text); }
                .pt-btn.pt-btn-go          { border-color: var(--pt-go); color: var(--pt-go); }
                .pt-btn.pt-btn-go:hover    { background: rgba(31,223,127,.1); }

                /* ── Run-date bar ── */
                .pt-rdb {
                    background: var(--pt-surface);
                    border-bottom: 1px solid var(--pt-border);
                    display: flex; align-items: baseline; gap: 14px;
                    padding: 10px 20px;
                }
                .pt-rdb-label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--pt-muted); flex-shrink: 0; }
                .pt-rdb-date  { font-size: 28px; font-weight: 600; letter-spacing: .03em; color: var(--pt-go); }
                .pt-rdb-date.stale { color: var(--pt-broken); }
                .pt-rdb-age   { font-size: 14px; color: var(--pt-sub); }
                .pt-rdb-age.stale { color: var(--pt-watch); font-weight: 600; }

                /* ── Stale banner ── */
                .pt-stale {
                    background: rgba(240,64,64,.07);
                    border-bottom: 1px solid rgba(240,64,64,.22);
                    padding: 7px 20px;
                    font-size: 11px; color: #f07070; letter-spacing: .04em;
                }
                .pt-stale strong { color: var(--pt-broken); }

                /* ── Poll bar ── */
                .pt-pollbar {
                    background: rgba(31,223,127,.04);
                    border-bottom: 1px solid rgba(31,223,127,.18);
                    display: flex; align-items: center; gap: 10px;
                    padding: 7px 20px;
                }
                .pt-spinner {
                    width: 11px; height: 11px; flex-shrink: 0;
                    border: 2px solid rgba(31,223,127,.15); border-top-color: var(--pt-go);
                    border-radius: 50%; animation: pt-spin .7s linear infinite;
                }
                @keyframes pt-spin { to { transform: rotate(360deg); } }
                .pt-polltext    { font-size: 11px; color: var(--pt-go); letter-spacing: .05em; }
                .pt-pollcount   { margin-left: auto; font-size: 11px; color: var(--pt-muted); }

                /* ── Error ── */
                .pt-error {
                    background: rgba(240,64,64,.08);
                    border: 1px solid rgba(240,64,64,.3);
                    border-radius: 3px; margin: 10px 20px 0;
                    padding: 8px 16px; font-size: 11px; color: var(--pt-broken);
                }

                /* ── Stats bar ── */
                .pt-stats {
                    background: var(--pt-surface);
                    border-bottom: 1px solid var(--pt-border);
                    display: flex; align-items: center;
                    padding: 0 20px; gap: 0;
                }
                .pt-stat {
                    display: flex; align-items: center; gap: 10px;
                    padding: 10px 24px 10px 0; margin-right: 24px;
                    border-right: 1px solid var(--pt-border);
                }
                .pt-stat:last-child { border-right: none; }
                .pt-stat-n   { font-size: 22px; font-weight: 600; line-height: 1; }
                .pt-stat-lbl { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--pt-muted); }
                .pt-n-total  { color: var(--pt-text); }
                .pt-n-go     { color: var(--pt-go); }
                .pt-n-watch  { color: var(--pt-watch); }
                .pt-n-broken { color: var(--pt-broken); }

                /* ── Column headers ── */
                .pt-col-hdr {
                    display: grid;
                    grid-template-columns: 80px 115px 80px 195px 125px 192px 1fr 160px;
                    padding: 8px 12px 8px 32px;
                    font-size: 12px; letter-spacing: .09em; text-transform: uppercase;
                    color: var(--pt-text); border-bottom: 1px solid var(--pt-border);
                    margin-top: 8px;
                }

                /* ── Cards ── */
                .pt-cards { display: flex; flex-direction: column; gap: 5px; padding: 8px 12px 24px; }
                .pt-empty { text-align: center; padding: 80px; font-size: 13px; color: var(--pt-muted); }

                .pt-card {
                    background: var(--pt-surface);
                    border: 1px solid var(--pt-border);
                    border-left: 3px solid var(--pt-border);
                    border-radius: 3px; overflow: hidden;
                }
                .pt-card.GO      { border-left-color: var(--pt-go); }
                .pt-card.WATCH   { border-left-color: var(--pt-watch); }
                .pt-card.BROKEN  { border-left-color: var(--pt-broken); }
                .pt-card.PAUSED  { border-left-color: var(--pt-paused); opacity: .5; }
                .pt-card.ENTERED { border-left-color: var(--pt-entered); opacity: .55; }
                .pt-card.WALKED,
                .pt-card.EXPIRED { border-left-color: var(--pt-muted); opacity: .4; }

                .pt-crow {
                    display: grid;
                    grid-template-columns: 80px 115px 80px 195px 125px 192px 1fr 160px;
                    align-items: center;
                    padding: 16px 20px;
                    user-select: none;
                }

                /* ── Cell styles ── */
                .pt-c-ticker {
                    font-size: 22px; font-weight: 600; color: #fff;
                    cursor: pointer; transition: color .12s;
                }
                .pt-c-ticker:hover { color: var(--pt-fav); text-decoration: underline; text-underline-offset: 3px; }

                .pt-c-rec { font-size: 13px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; line-height: 1.4; }
                .pt-c-rec.FAVORABLE { color: var(--pt-fav); }
                .pt-c-rec.MARGINAL  { color: var(--pt-mar); }

                .pt-c-score { font-size: 30px; font-weight: 600; color: var(--pt-text); }
                .pt-c-score sup { font-size: 13px; color: var(--pt-muted); font-weight: 400; vertical-align: super; }

                .pt-cell { display: flex; flex-direction: column; gap: 6px; }
                .pt-lbl  { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--pt-sub); font-weight: 500; }

                .pt-ppair { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
                .pt-p-snap { font-size: 18px; color: var(--pt-text); }
                .pt-p-arr  { font-size: 13px; color: var(--pt-muted); }
                .pt-p-live { font-size: 20px; font-weight: 600; }
                .pt-p-live.ok   { color: var(--pt-go); }
                .pt-p-live.warn { color: var(--pt-watch); }
                .pt-p-live.bad  { color: var(--pt-broken); }
                .pt-p-live.def  { color: var(--pt-text); }
                .pt-no-live { font-size: 13px; color: var(--pt-muted); margin-left: 4px; }

                .pt-big-val { font-size: 22px; font-weight: 600; }
                .pt-big-val.ok   { color: var(--pt-go); }
                .pt-big-val.warn { color: var(--pt-watch); }
                .pt-big-val.bad  { color: var(--pt-broken); }
                .pt-big-val.def  { color: var(--pt-text); }

                .pt-cpair  { display: flex; align-items: baseline; gap: 7px; }
                .pt-c-floor { font-size: 20px; font-weight: 600; }
                .pt-c-floor.ok   { color: var(--pt-go); }
                .pt-c-floor.warn { color: var(--pt-watch); }
                .pt-c-floor.bad  { color: var(--pt-broken); }
                .pt-c-floor.def  { color: var(--pt-text); }
                .pt-c-mid { font-size: 20px; font-weight: 600; }
                .pt-c-mid.ok   { color: var(--pt-go); }
                .pt-c-mid.warn { color: var(--pt-watch); }
                .pt-c-mid.bad  { color: var(--pt-broken); }
                .pt-c-mid.def  { color: var(--pt-sub); }

                /* ── Contract cell (colored by live status) ── */
                .pt-orig-contract {
                    display: block; font-size: 17px; font-weight: 600;
                    letter-spacing: .03em; white-space: nowrap;
                }
                .pt-orig-contract.GO      { color: var(--pt-go); }
                .pt-orig-contract.WATCH   { color: var(--pt-watch); }
                .pt-orig-contract.BROKEN  { color: var(--pt-broken); }
                .pt-orig-contract.NO_DATA,
                .pt-orig-contract.PAUSED,
                .pt-orig-contract.ENTERED,
                .pt-orig-contract.SUPERSEDED { color: var(--pt-sub); }

                .pt-alt-contract {
                    display: block; font-size: 15px; font-weight: 600;
                    color: var(--pt-go); margin-top: 5px; white-space: nowrap;
                }
                .pt-no-alt {
                    display: block; font-size: 13px; color: var(--pt-muted);
                    font-style: italic; margin-top: 4px;
                }

                .pt-c-status { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
                .pt-badge {
                    font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
                    padding: 6px 13px; border-radius: 2px; display: inline-block;
                }
                .pt-badge.GO      { background: rgba(31,223,127,.12); color: var(--pt-go);     border: 1px solid rgba(31,223,127,.3); }
                .pt-badge.WATCH   { background: rgba(245,166,35,.12); color: var(--pt-watch);  border: 1px solid rgba(245,166,35,.3); }
                .pt-badge.BROKEN  { background: rgba(240,64,64,.12);  color: var(--pt-broken); border: 1px solid rgba(240,64,64,.3); }
                .pt-badge.NO_DATA { background: rgba(85,102,119,.12); color: var(--pt-muted);  border: 1px solid rgba(85,102,119,.3); }
                .pt-badge.PAUSED  { background: rgba(106,122,138,.1); color: var(--pt-paused); border: 1px solid rgba(106,122,138,.3); }
                .pt-badge.ENTERED { background: rgba(0,170,255,.12);  color: var(--pt-entered);border: 1px solid rgba(0,170,255,.3); }
                .pt-badge.WALKED,
                .pt-badge.EXPIRED { background: rgba(85,102,119,.1);  color: var(--pt-muted);  border: 1px solid rgba(85,102,119,.3); }
                .pt-badge.ok      { background: rgba(31,223,127,.12); color: var(--pt-go);     border: 1px solid rgba(31,223,127,.3); }
                .pt-badge.drifted { background: rgba(245,166,35,.12); color: var(--pt-watch);  border: 1px solid rgba(245,166,35,.3); }
                .pt-cap-time { font-size: 13px; color: var(--pt-sub); }
                .pt-ai-btn {
                    font-family: inherit; font-size: 13px; color: var(--pt-muted); cursor: pointer;
                    padding: 5px 12px; border: 1px solid var(--pt-border2);
                    border-radius: 2px; background: transparent; transition: all .15s;
                }
                .pt-ai-btn:hover { color: var(--pt-fav); border-color: var(--pt-fav); }

                /* ── Always-visible metrics + actions row ── */
                .pt-metrics-row {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 8px 20px 10px 32px;
                    border-top: 1px solid var(--pt-border);
                    background: rgba(0,0,0,.20); flex-wrap: wrap; gap: 8px;
                }
                .pt-metrics-left { display: flex; align-items: center; gap: 12px; }
                .pt-mval { font-size: 15px; color: var(--pt-sub); letter-spacing: .05em; text-transform: uppercase; }
                .pt-mval strong { color: var(--pt-text); font-weight: 700; font-size: 16px; }
                .pt-msep { color: var(--pt-border2); font-size: 18px; }
                .pt-metrics-actions { display: flex; align-items: center; gap: 8px; }
                .pt-albl { font-size: 13px; color: var(--pt-muted); letter-spacing: .07em; text-transform: uppercase; margin-right: 4px; }
                .pt-abtn {
                    font-family: inherit; font-size: 13px; font-weight: 600;
                    letter-spacing: .06em; text-transform: uppercase;
                    padding: 7px 18px; border-radius: 2px;
                    border: 1px solid var(--pt-border2); background: transparent;
                    color: var(--pt-sub); cursor: pointer; transition: all .15s;
                }
                .pt-abtn:hover         { color: var(--pt-text); border-color: var(--pt-text); }
                .pt-abtn.enter:hover   { color: var(--pt-go);     border-color: var(--pt-go);     background: rgba(31,223,127,.07); }
                .pt-abtn.walk:hover    { color: var(--pt-watch);  border-color: var(--pt-watch);  background: rgba(245,166,35,.07); }
                .pt-abtn.pause:hover   { color: var(--pt-paused); border-color: var(--pt-paused); }
                .pt-abtn.unpause:hover { color: var(--pt-go);     border-color: var(--pt-go); }
                .pt-abtn.reset:hover   { color: var(--pt-sub);    border-color: var(--pt-sub); }

                /* ── Narrative ── */
                .pt-narr {
                    display: none; padding: 16px 20px;
                    border-top: 1px solid var(--pt-border);
                    background: rgba(0,0,0,.35);
                    font-size: 14px; line-height: 1.75; color: var(--pt-sub);
                    white-space: pre-wrap; word-break: break-word;
                    max-height: 440px; overflow-y: auto;
                }
                .pt-card.narr-open .pt-narr { display: block; }

                .pt-shell ::-webkit-scrollbar { width: 4px; }
                .pt-shell ::-webkit-scrollbar-track { background: var(--pt-bg); }
                .pt-shell ::-webkit-scrollbar-thumb { background: var(--pt-border2); border-radius: 2px; }
            `}</style>

            <div className="pt-root pt-shell">
                {/* ── Toolbar ── */}
                <div className="pt-toolbar">
                    <div className="pt-toolbar-left">
                        <span className="pt-logo">CC Prospects</span>
                        {runDate && (
                            <span className="pt-run-label">RUN {runDate}</span>
                        )}
                    </div>
                    <div className="pt-toolbar-right">
                        {lastUpdated && (
                            <span className="pt-updated">updated {lastUpdated}</span>
                        )}
                        <button className="pt-btn pt-btn-go" onClick={load} disabled={loading}>
                            {loading ? '…' : '↻ Refresh'}
                        </button>
                        <button className="pt-btn" onClick={poll} disabled={polling}>
                            {polling ? 'Polling…' : 'Poll Now'}
                        </button>
                    </div>
                </div>

                {/* ── Run-date bar ── */}
                {runDate && (
                    <div className="pt-rdb">
                        <span className="pt-rdb-label">Data as of</span>
                        <span className={`pt-rdb-date${isStale ? ' stale' : ''}`}>{fmtRunDate}</span>
                        <span className={`pt-rdb-age${isStale ? ' stale' : ''}`}>{ageLabel}</span>
                    </div>
                )}

                {/* ── Stale banner ── */}
                {isStale && (
                    <div className="pt-stale">
                        ⚠️ <strong>Stale data</strong> — Run date {runDate} is {mda} market days old.
                        Re-run the Entry pipeline (WF40) to refresh.
                    </div>
                )}

                {/* ── Poll progress bar ── */}
                {polling && (
                    <div className="pt-pollbar">
                        <div className="pt-spinner" />
                        <span className="pt-polltext">Polling Schwab — live quotes updating in background…</span>
                        <span className="pt-pollcount">
                            {pollSecs > 0
                                ? `Auto-refresh in ${Math.floor(pollSecs / 60) > 0 ? Math.floor(pollSecs / 60) + 'm ' : ''}${pollSecs % 60}s`
                                : 'Refreshing…'}
                        </span>
                    </div>
                )}

                {/* ── Error ── */}
                {error && <div className="pt-error">{error}</div>}

                {/* ── Stats ── */}
                <div className="pt-stats">
                    <div className="pt-stat">
                        <span className="pt-stat-n pt-n-total">{stats.total}</span>
                        <span className="pt-stat-lbl">Total</span>
                    </div>
                    <div className="pt-stat">
                        <span className="pt-stat-n pt-n-go">{stats.GO}</span>
                        <span className="pt-stat-lbl">Go</span>
                    </div>
                    <div className="pt-stat">
                        <span className="pt-stat-n pt-n-watch">{stats.WATCH}</span>
                        <span className="pt-stat-lbl">Watch</span>
                    </div>
                    <div className="pt-stat">
                        <span className="pt-stat-n pt-n-broken">{stats.BROKEN}</span>
                        <span className="pt-stat-lbl">Broken</span>
                    </div>
                </div>

                {/* ── Column headers ── */}
                {candidates.length > 0 && (
                    <div className="pt-col-hdr">
                        <div>Ticker</div>
                        <div>Rec</div>
                        <div>Score</div>
                        <div>Stock snap → live</div>
                        <div>Entry Limit</div>
                        <div>Call floor → live</div>
                        <div>Contract / Live Best</div>
                        <div style={{ textAlign: 'right', paddingRight: '4px' }}>Status</div>
                    </div>
                )}

                {/* ── Cards ── */}
                <div className="pt-cards">
                    {candidates.length === 0 && !loading && (
                        <div className="pt-empty">
                            {data === null ? 'Loading prospects…' : 'No candidates for today.'}
                        </div>
                    )}
                    {candidates.map(c => (
                        <ProspectCard
                            key={c.ticker}
                            c={c}
                            isNarrOpen={narrCards.has(c.ticker)}
                            onToggleNarr={(e) => toggleNarr(c.ticker, e)}
                            onSetStatus={setStatus}
                            onEntered={handleEntered}
                            onTickerClick={openChart}
                        />
                    ))}
                </div>
            </div>

            {/* ── Ticker chart modal ── */}
            <TickerModal
                isOpen={chartModal.open}
                onClose={closeChart}
                ticker={chartModal.ticker}
                prospect={chartModal.prospect}
            />
        </>
    );
}

// ── ProspectCard ─────────────────────────────────────────────────────────────
function ProspectCard({ c, isNarrOpen, onToggleNarr, onSetStatus, onEntered, onTickerClick }) {
    const bk      = badgeKey(c);
    const rd      = c.run_date || '';
    const paused  = !!c.paused;
    const done    = ['ENTERED', 'WALKED', 'EXPIRED'].includes((c.status || '').toUpperCase());

    // Stock snap → live
    const snapStr = c.stock_price_snapshot != null ? `$${f2(c.stock_price_snapshot)}` : '—';
    const liveStr = c.stock_price != null ? `$${f2(c.stock_price)}` : null;
    const pCls    = priceClass(c.stock_price, c.stock_ceiling);

    // Entry limit
    const ceilStr = c.stock_ceiling != null ? `$${f2(c.stock_ceiling)}` : '—';
    const ceilCls = priceClass(c.stock_price, c.stock_ceiling);

    // Call floor → live mid
    const floorStr = c.call_floor != null ? `$${f2(c.call_floor)}` : '—';
    const midStr   = c.call_mid   != null ? `$${f2(c.call_mid)}`   : '—';
    const fCls     = floorClass(c.call_mid, c.call_floor);
    const mCls     = callMidClass(c.call_mid, c.call_floor);

    // Contract display
    const strike = c.strike != null ? `$${f2(c.strike)}` : '—';
    const exp    = c.expiration_date ? String(c.expiration_date).slice(5, 10).replace('-', '/') : '—';
    const dte    = c.dte != null ? `${c.dte}d` : '';
    const ivStr  = c.iv  != null ? `IV ${(Number(c.iv) * 100).toFixed(1)}%` : '';

    // Overall status for contract coloring (separate from badge key)
    const overallCls = paused ? 'PAUSED'
        : (c.overall_status || 'NO_DATA').toUpperCase();

    // When a better alternate exists and the original was GO, show it as neutral —
    // the alternate IS the recommendation, so two greens would be confusing.
    // WATCH and BROKEN keep their color even with an alternate (still informative).
    // Computed after lc/isSameContract — but we define origCls after those below.

    // Captured time
    const capTime = c.captured_at
        ? new Date(c.captured_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : 'no data';

    // Live best contract
    const lc = c.live_contract;
    const hasLC = lc && lc.drift_status;
    const isSameContract = hasLC
        && lc.strike != null && c.strike != null
        && Number(lc.strike) === Number(c.strike)
        && String(lc.expiration_date).slice(0, 10) === String(c.expiration_date).slice(0, 10);
    const showNoAlt = (isSameContract || !hasLC)
        && ['WATCH', 'BROKEN'].includes((c.overall_status || '').toUpperCase());

    // Original contract color: GO is demoted to neutral when a better alternate exists
    // (avoids "two greens" confusion). WATCH/BROKEN keep their color regardless.
    const origCls = (overallCls === 'GO' && hasLC && !isSameContract)
        ? 'SUPERSEDED'
        : overallCls;

    const cardClasses = ['pt-card', bk, isNarrOpen ? 'narr-open' : ''].filter(Boolean).join(' ');

    return (
        <div className={cardClasses}>
            {/* ── Main data row ── */}
            <div className="pt-crow">
                {/* Ticker */}
                <div
                    className="pt-c-ticker"
                    onClick={e => { e.stopPropagation(); onTickerClick(c); }}
                    title={`Chart ${c.ticker}`}
                >{c.ticker}</div>

                {/* Rec */}
                <div className={`pt-c-rec ${c.recommendation || ''}`}>
                    {c.recommendation || '—'}
                </div>

                {/* Score */}
                <div className="pt-c-score">
                    {c.score != null ? Number(c.score).toFixed(1) : '—'}
                    <sup>/10</sup>
                </div>

                {/* Stock snap → live */}
                <div className="pt-cell">
                    <span className="pt-lbl">Stock</span>
                    <div className="pt-ppair">
                        <span className="pt-p-snap">{snapStr}</span>
                        {liveStr
                            ? <><span className="pt-p-arr">→</span><span className={`pt-p-live ${pCls}`}>{liveStr}</span></>
                            : <span className="pt-no-live">no live</span>}
                    </div>
                </div>

                {/* Entry limit */}
                <div className="pt-cell">
                    <span className="pt-lbl">Entry Limit +2%</span>
                    <span className={`pt-big-val ${ceilCls}`}>{ceilStr}</span>
                </div>

                {/* Call floor → live mid */}
                <div className="pt-cell">
                    <span className="pt-lbl">Call floor → live</span>
                    <div className="pt-cpair">
                        <span className={`pt-c-floor ${fCls}`}>{floorStr}</span>
                        <span className="pt-p-arr">→</span>
                        <span className={`pt-c-mid ${mCls}`}>{midStr}</span>
                    </div>
                </div>

                {/* Contract — colored by live status; alt contract below if different */}
                <div className="pt-cell">
                    <span className="pt-lbl">Contract / Live Best</span>
                    <span className={`pt-orig-contract ${origCls}`}>
                        {strike}  {exp}  {dte}  δ{d3(c.delta)}  {ivStr}
                    </span>
                    {!isSameContract && hasLC && (
                        <span className="pt-alt-contract">
                            ↳ ${f2(lc.strike)}  {String(lc.expiration_date).slice(5,10).replace('-','/')}  {lc.dte != null ? `${lc.dte}d` : ''}
                            {lc.premium_mid != null ? `  ·  $${f2(lc.premium_mid)}` : ''}
                            {lc.annualized_yield != null ? `  ${Number(lc.annualized_yield).toFixed(1)}% ann` : ''}
                        </span>
                    )}
                    {showNoAlt && (
                        <span className="pt-no-alt">no alternate contract found</span>
                    )}
                </div>

                {/* Status */}
                <div className="pt-c-status">
                    <span className={`pt-badge ${bk}`}>{bk}</span>
                    <span className="pt-cap-time">{capTime}</span>
                </div>
            </div>

            {/* ── Always-visible metrics + action row ── */}
            <div className="pt-metrics-row">
                <div className="pt-metrics-left">
                    <span className="pt-mval">BE <strong>${f2(c.breakeven)}</strong></span>
                    <span className="pt-msep">·</span>
                    <span className="pt-mval">CUSHION <strong>{pct(c.cushion_pct)}</strong></span>
                    <span className="pt-msep">·</span>
                    <span className="pt-mval">YIELD <strong>{pct(c.annualized_yield)}</strong></span>
                    <button className="pt-ai-btn" onClick={onToggleNarr} style={{ marginLeft: 12 }}>AI ▾</button>
                </div>
                <div className="pt-metrics-actions" onClick={e => e.stopPropagation()}>
                    <span className="pt-albl">Mark:</span>
                    <button className="pt-abtn enter" onClick={e => onEntered(e, c)}>✓ Entered</button>
                    <button className="pt-abtn walk"  onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { status: 'WALKED' }); }}>✗ Walked</button>
                    {paused
                        ? <button className="pt-abtn unpause" onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { paused: false }); }}>▶ Resume</button>
                        : <button className="pt-abtn pause"   onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { paused: true }); }}>⏸ Pause</button>
                    }
                    {(done || paused) && (
                        <button className="pt-abtn reset" onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { status: 'PENDING', paused: false }); }}>↺ Reset</button>
                    )}
                </div>
            </div>

            {/* ── AI narrative (toggled) ── */}
            <div className="pt-narr">{c.report_text || ''}</div>
        </div>
    );
}
