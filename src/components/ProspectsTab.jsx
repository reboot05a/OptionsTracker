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

    // Card open / narrative-open state (Set of tickers)
    const [openCards, setOpenCards]   = useState(new Set());
    const [narrCards, setNarrCards]   = useState(new Set());

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
                })
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

    // ── Card toggle helpers ───────────────────────────────────────────────
    const toggleCard = useCallback((ticker) => {
        setOpenCards(prev => {
            const next = new Set(prev);
            next.has(ticker) ? next.delete(ticker) : next.add(ticker);
            return next;
        });
    }, []);

    const toggleNarr = useCallback((ticker, e) => {
        e.stopPropagation();
        setNarrCards(prev => {
            const next = new Set(prev);
            next.has(ticker) ? next.delete(ticker) : next.add(ticker);
            return next;
        });
    }, []);

    // ── Derived run-date state ────────────────────────────────────────────
    const runDate  = data?.run_date ?? null;
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
                    font-size: 12px; font-weight: 600; letter-spacing: .14em;
                    color: var(--pt-go); text-transform: uppercase;
                }
                .pt-run-label { font-size: 11px; color: var(--pt-muted); letter-spacing: .06em; }
                .pt-updated   { font-size: 11px; color: var(--pt-muted); }
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
                .pt-rdb-label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--pt-muted); flex-shrink: 0; }
                .pt-rdb-date  { font-size: 26px; font-weight: 600; letter-spacing: .03em; color: var(--pt-go); }
                .pt-rdb-date.stale { color: var(--pt-broken); }
                .pt-rdb-age   { font-size: 12px; color: var(--pt-sub); }
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
                    grid-template-columns: 70px 100px 80px 200px 120px 180px 170px 160px 110px;
                    padding: 8px 12px 8px 16px;
                    font-size: 11px; letter-spacing: .09em; text-transform: uppercase;
                    color: var(--pt-sub); border-bottom: 1px solid var(--pt-border);
                    margin-top: 8px;
                }

                /* ── Cards ── */
                .pt-cards { display: flex; flex-direction: column; gap: 5px; padding: 8px 20px 24px; }
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
                    grid-template-columns: 70px 100px 80px 200px 120px 180px 170px 160px 110px;
                    align-items: center;
                    padding: 12px;
                    cursor: pointer; user-select: none;
                }
                .pt-crow:hover { background: rgba(255,255,255,.025); }

                /* ── Cell styles ── */
                .pt-c-ticker { font-size: 17px; font-weight: 600; color: #fff; }

                .pt-c-rec { font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; line-height: 1.3; }
                .pt-c-rec.FAVORABLE { color: var(--pt-fav); }
                .pt-c-rec.MARGINAL  { color: var(--pt-mar); }

                .pt-c-score { font-size: 24px; font-weight: 600; color: var(--pt-text); }
                .pt-c-score sup { font-size: 11px; color: var(--pt-muted); font-weight: 400; vertical-align: super; }

                .pt-cell { display: flex; flex-direction: column; gap: 5px; }
                .pt-lbl  { font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--pt-sub); font-weight: 500; }

                .pt-ppair { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
                .pt-p-snap { font-size: 15px; color: var(--pt-text); }
                .pt-p-arr  { font-size: 11px; color: var(--pt-muted); }
                .pt-p-live { font-size: 16px; font-weight: 600; }
                .pt-p-live.ok   { color: var(--pt-go); }
                .pt-p-live.warn { color: var(--pt-watch); }
                .pt-p-live.bad  { color: var(--pt-broken); }
                .pt-p-live.def  { color: var(--pt-text); }
                .pt-no-live { font-size: 11px; color: var(--pt-muted); margin-left: 4px; }

                .pt-big-val { font-size: 18px; font-weight: 600; }
                .pt-big-val.ok   { color: var(--pt-go); }
                .pt-big-val.warn { color: var(--pt-watch); }
                .pt-big-val.bad  { color: var(--pt-broken); }
                .pt-big-val.def  { color: var(--pt-text); }

                .pt-cpair  { display: flex; align-items: baseline; gap: 6px; }
                .pt-c-floor { font-size: 16px; font-weight: 600; }
                .pt-c-floor.ok   { color: var(--pt-go); }
                .pt-c-floor.warn { color: var(--pt-watch); }
                .pt-c-floor.bad  { color: var(--pt-broken); }
                .pt-c-floor.def  { color: var(--pt-text); }
                .pt-c-mid { font-size: 16px; font-weight: 600; }
                .pt-c-mid.ok   { color: var(--pt-go); }
                .pt-c-mid.warn { color: var(--pt-watch); }
                .pt-c-mid.bad  { color: var(--pt-broken); }
                .pt-c-mid.def  { color: var(--pt-sub); }

                .pt-contract-top { font-size: 15px; color: var(--pt-text); font-weight: 600; }
                .pt-contract-sub { font-size: 13px; color: var(--pt-sub); margin-top: 3px; }

                .pt-thresh { display: flex; flex-direction: column; gap: 5px; }
                .pt-trow   { display: flex; align-items: baseline; gap: 8px; }
                .pt-tk { font-size: 11px; color: var(--pt-sub); width: 58px; flex-shrink: 0; letter-spacing: .06em; text-transform: uppercase; font-weight: 500; }
                .pt-tv { font-size: 15px; color: var(--pt-text); font-weight: 600; }

                .pt-c-status { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
                .pt-badge {
                    font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
                    padding: 4px 10px; border-radius: 2px; display: inline-block;
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
                .pt-cap-time { font-size: 11px; color: var(--pt-sub); }
                .pt-ai-btn {
                    font-family: inherit; font-size: 10px; color: var(--pt-muted); cursor: pointer;
                    padding: 3px 8px; border: 1px solid var(--pt-border2);
                    border-radius: 2px; background: transparent; transition: all .15s;
                }
                .pt-ai-btn:hover { color: var(--pt-fav); border-color: var(--pt-fav); }

                /* ── Action row ── */
                .pt-arow {
                    display: none; align-items: center; gap: 8px;
                    padding: 9px 16px 11px; border-top: 1px solid var(--pt-border);
                    background: rgba(0,0,0,.25); flex-wrap: wrap;
                }
                .pt-card.open .pt-arow { display: flex; }
                .pt-albl { font-size: 10px; color: var(--pt-muted); letter-spacing: .07em; text-transform: uppercase; margin-right: 4px; }
                .pt-abtn {
                    font-family: inherit; font-size: 10px; font-weight: 600;
                    letter-spacing: .07em; text-transform: uppercase;
                    padding: 5px 14px; border-radius: 2px;
                    border: 1px solid var(--pt-border2); background: transparent;
                    color: var(--pt-sub); cursor: pointer; transition: all .15s;
                }
                .pt-abtn:hover         { color: var(--pt-text); border-color: var(--pt-text); }
                .pt-abtn.enter:hover   { color: var(--pt-go);     border-color: var(--pt-go);     background: rgba(31,223,127,.07); }
                .pt-abtn.walk:hover    { color: var(--pt-watch);  border-color: var(--pt-watch);  background: rgba(245,166,35,.07); }
                .pt-abtn.pause:hover   { color: var(--pt-paused); border-color: var(--pt-paused); }
                .pt-abtn.unpause:hover { color: var(--pt-go);     border-color: var(--pt-go); }
                .pt-abtn.reset:hover   { color: var(--pt-sub);    border-color: var(--pt-sub); }

                /* ── Live contract panel ── */
                .pt-lc-panel {
                    display: none; align-items: center; gap: 16px; flex-wrap: wrap;
                    padding: 10px 16px 11px; border-top: 1px solid var(--pt-border);
                    background: rgba(0,0,0,.20); font-size: 13px;
                }
                .pt-card.open .pt-lc-panel { display: flex; }
                .pt-lc-label    { font-size: 11px; font-weight: 600; letter-spacing: .1em; color: var(--pt-sub); text-transform: uppercase; margin-right: 2px; }
                .pt-lc-contract { color: var(--pt-text); font-weight: 600; letter-spacing: .04em; }
                .pt-lc-sub      { color: var(--pt-sub); }
                .pt-lc-prem     { color: var(--pt-go); font-weight: 600; }
                .pt-lc-yield    { font-weight: 600; }
                .pt-lc-yield.ok      { color: var(--pt-go); }
                .pt-lc-yield.drifted { color: var(--pt-watch); }
                .pt-lc-oi       { color: var(--pt-sub); }
                .pt-lc-cmp      { color: var(--pt-sub); font-size: 12px; }

                /* ── Narrative ── */
                .pt-narr {
                    display: none; padding: 16px 20px;
                    border-top: 1px solid var(--pt-border);
                    background: rgba(0,0,0,.35);
                    font-size: 12px; line-height: 1.7; color: var(--pt-sub);
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
                    <div className="pt-col-hdr" style={{ padding: '8px 12px 8px 36px' }}>
                        <div>Ticker</div>
                        <div>Rec</div>
                        <div>Score</div>
                        <div>Stock snap → live</div>
                        <div>Entry Limit</div>
                        <div>Call floor → live</div>
                        <div>Contract</div>
                        <div>BE / Cushion / Yield</div>
                        <div style={{ textAlign: 'right' }}>Status</div>
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
                            isOpen={openCards.has(c.ticker)}
                            isNarrOpen={narrCards.has(c.ticker)}
                            onToggle={() => toggleCard(c.ticker)}
                            onToggleNarr={(e) => toggleNarr(c.ticker, e)}
                            onSetStatus={setStatus}
                            onEntered={handleEntered}
                        />
                    ))}
                </div>
            </div>
        </>
    );
}

// ── ProspectCard ─────────────────────────────────────────────────────────────
function ProspectCard({ c, isOpen, isNarrOpen, onToggle, onToggleNarr, onSetStatus, onEntered }) {
    const bk     = badgeKey(c);
    const rd     = c.run_date || '';
    const paused = !!c.paused;
    const done   = ['ENTERED', 'WALKED', 'EXPIRED', 'BROKEN'].includes((c.status || '').toUpperCase());

    // Stock snap → live
    const snapStr  = c.stock_price_snapshot != null ? `$${f2(c.stock_price_snapshot)}` : '—';
    const liveStr  = c.stock_price != null ? `$${f2(c.stock_price)}` : null;
    const pCls     = priceClass(c.stock_price, c.stock_ceiling);

    // Entry limit
    const ceilStr  = c.stock_ceiling != null ? `$${f2(c.stock_ceiling)}` : '—';
    const ceilCls  = priceClass(c.stock_price, c.stock_ceiling);

    // Call floor → live mid
    const floorStr = c.call_floor != null ? `$${f2(c.call_floor)}` : '—';
    const midStr   = c.call_mid   != null ? `$${f2(c.call_mid)}`   : '—';
    const fCls     = floorClass(c.call_mid, c.call_floor);
    const mCls     = callMidClass(c.call_mid, c.call_floor);

    // Contract
    const strike   = c.strike != null ? `$${f2(c.strike)}` : '—';
    const exp      = c.expiration_date ? String(c.expiration_date).slice(5, 10).replace('-', '/') : '—';
    const dte      = c.dte != null ? `${c.dte}d` : '';
    const iv       = c.iv  != null ? `IV ${(Number(c.iv) * 100).toFixed(1)}%` : '';

    // Captured time
    const capTime  = c.captured_at
        ? new Date(c.captured_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : 'no data';

    // Live contract panel
    const lc = c.live_contract;
    const hasLC = lc && lc.drift_status;

    // Card classes
    const cardClasses = [
        'pt-card', bk,
        isOpen     ? 'open'      : '',
        isNarrOpen ? 'narr-open' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={cardClasses}>
            {/* ── Main row ── */}
            <div className="pt-crow" onClick={onToggle}>
                {/* Ticker */}
                <div className="pt-c-ticker">{c.ticker}</div>

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
                            : <span className="pt-no-live">no live</span>
                        }
                    </div>
                </div>

                {/* Entry limit */}
                <div className="pt-cell">
                    <span className="pt-lbl">Entry Limit +2%</span>
                    <span className={`pt-big-val ${ceilCls}`}>{ceilStr}</span>
                </div>

                {/* Call floor → live */}
                <div className="pt-cell">
                    <span className="pt-lbl">Call floor → live</span>
                    <div className="pt-cpair">
                        <span className={`pt-c-floor ${fCls}`}>{floorStr}</span>
                        <span className="pt-p-arr">→</span>
                        <span className={`pt-c-mid ${mCls}`}>{midStr}</span>
                    </div>
                </div>

                {/* Contract */}
                <div className="pt-cell">
                    <span className="pt-lbl">Contract</span>
                    <span className="pt-contract-top">{strike}  {exp}  {dte}</span>
                    <span className="pt-contract-sub">δ{d3(c.delta)}  {iv}</span>
                </div>

                {/* BE / Cushion / Yield */}
                <div className="pt-thresh">
                    <div className="pt-trow"><span className="pt-tk">BE</span><span className="pt-tv">${f2(c.breakeven)}</span></div>
                    <div className="pt-trow"><span className="pt-tk">Cushion</span><span className="pt-tv">{pct(c.cushion_pct)}</span></div>
                    <div className="pt-trow"><span className="pt-tk">Yield</span><span className="pt-tv">{pct(c.annualized_yield)}</span></div>
                </div>

                {/* Status */}
                <div className="pt-c-status">
                    <span className={`pt-badge ${bk}`}>{bk}</span>
                    <span className="pt-cap-time">{capTime}</span>
                    <button className="pt-ai-btn" onClick={onToggleNarr}>AI ▾</button>
                </div>
            </div>

            {/* ── Action row ── */}
            <div className="pt-arow" onClick={e => e.stopPropagation()}>
                <span className="pt-albl">Mark:</span>
                <button
                    className="pt-abtn enter"
                    onClick={e => onEntered(e, c)}
                >✓ Entered</button>
                <button
                    className="pt-abtn walk"
                    onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { status: 'WALKED' }); }}
                >✗ Walked</button>
                {paused
                    ? <button
                        className="pt-abtn unpause"
                        onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { paused: false }); }}
                      >▶ Resume</button>
                    : <button
                        className="pt-abtn pause"
                        onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { paused: true }); }}
                      >⏸ Pause</button>
                }
                {(done || paused) && (
                    <button
                        className="pt-abtn reset"
                        onClick={e => { e.stopPropagation(); onSetStatus(c.ticker, rd, { status: 'PENDING', paused: false }); }}
                    >↺ Reset</button>
                )}
            </div>

            {/* ── Live best contract panel ── */}
            <div className="pt-lc-panel">
                <span className="pt-lc-label">Live Best</span>
                {hasLC ? (
                    <>
                        <span className={`pt-badge ${lc.drift_status.toLowerCase()}`}>{lc.drift_status}</span>
                        <span className="pt-lc-contract">
                            {lc.strike != null ? `$${f2(lc.strike)}` : '—'}{' '}
                            {lc.expiration_date ? String(lc.expiration_date).slice(5, 10).replace('-', '/') : '—'}{' '}
                            {lc.dte != null ? `${lc.dte}d` : ''}
                        </span>
                        <span className="pt-lc-sub">
                            {lc.delta != null ? `δ${d3(lc.delta)}` : ''}{' '}
                            {lc.iv    != null ? `IV ${(Number(lc.iv) * 100).toFixed(1)}%` : ''}
                        </span>
                        {lc.premium_mid     != null && <span className="pt-lc-prem">${f2(lc.premium_mid)}</span>}
                        {lc.annualized_yield != null && (
                            <span className={`pt-lc-yield ${lc.drift_status.toLowerCase()}`}>
                                {Number(lc.annualized_yield).toFixed(1)}% ann
                            </span>
                        )}
                        {lc.open_interest    != null && <span className="pt-lc-oi">OI {lc.open_interest}</span>}
                        {lc.yield_vs_report  != null && <span className="pt-lc-cmp">{lc.yield_vs_report}% of report yield</span>}
                    </>
                ) : (
                    <span style={{ color: 'var(--pt-muted)', fontStyle: 'italic' }}>
                        no contract passes guardrails
                    </span>
                )}
            </div>

            {/* ── AI narrative ── */}
            <div className="pt-narr">
                {c.report_text || ''}
            </div>
        </div>
    );
}
