/**
 * TickerModal.jsx
 *
 * Full-screen chart modal powered by TradingView free embed.
 * Right panel shows prospect context when available (score, contract,
 * entry limits, breakeven, yield, live contract drift).
 *
 * Props:
 *   isOpen    — boolean
 *   onClose   — () => void
 *   ticker    — string, e.g. "BLDR"
 *   prospect  — optional cc_daily_candidates row (full object from ProspectsTab)
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Formatting helpers ──────────────────────────────────────────────────────
const f2  = v => v != null ? Number(v).toFixed(2) : '—';
const pct = v => v != null ? Number(v).toFixed(1) + '%' : '—';
const d3  = v => v != null ? Number(v).toFixed(3) : '—';

// ── TradingView embed chart ─────────────────────────────────────────────────
function TradingViewChart({ ticker, interval }) {
    const containerRef = useRef(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        container.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'tradingview-widget-container__widget';
        inner.style.cssText = 'width:100%;height:100%;';
        container.appendChild(inner);

        const script = document.createElement('script');
        script.type  = 'text/javascript';
        script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
        script.async = true;
        script.textContent = JSON.stringify({
            autosize:            true,
            symbol:              ticker,
            interval,
            timezone:            'America/New_York',
            theme:               'dark',
            style:               '1',
            locale:              'en',
            allow_symbol_change: false,
            hide_legend:         false,
            studies: ['RSI@tv-basicstudies', 'MASimple@tv-basicstudies', 'BB@tv-basicstudies'],
        });
        container.appendChild(script);

        return () => { container.innerHTML = ''; };
    }, [ticker, interval]);

    return (
        <div
            ref={containerRef}
            className="tradingview-widget-container"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
    );
}

// ── Main component ──────────────────────────────────────────────────────────
export function TickerModal({ isOpen, onClose, ticker, prospect }) {
    const [interval, setIntervalVal] = useState('D');

    // Escape key
    useEffect(() => {
        if (!isOpen) return;
        const h = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [isOpen, onClose]);

    // Prevent body scroll while open
    useEffect(() => {
        document.body.style.overflow = isOpen ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isOpen]);

    if (!isOpen || !ticker) return null;

    const hasProspect = !!prospect;
    const bk = hasProspect ? badgeKey(prospect) : null;

    return (
        <>
            <style>{`
                .tm-overlay {
                    position: fixed; inset: 0; z-index: 1000;
                    background: rgba(0,0,0,.72);
                    display: flex; align-items: center; justify-content: center;
                    padding: 20px;
                }
                .tm-modal {
                    background: #0d0f12;
                    border: 1px solid #1f2530;
                    border-radius: 6px;
                    width: 100%; max-width: 1480px;
                    height: 90vh;
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    font-family: 'IBM Plex Mono', 'Courier New', monospace;
                }

                /* ── Header bar ── */
                .tm-header {
                    background: #13161b;
                    border-bottom: 1px solid #1f2530;
                    display: flex; align-items: center; gap: 16px;
                    padding: 0 20px; height: 52px; flex-shrink: 0;
                }
                .tm-ticker {
                    font-size: 22px; font-weight: 700; color: #fff;
                    letter-spacing: .05em;
                }
                .tm-rec {
                    font-size: 13px; font-weight: 600; letter-spacing: .08em;
                    text-transform: uppercase; padding: 4px 12px;
                    border-radius: 2px;
                }
                .tm-rec.FAVORABLE { color: #00aaff; border: 1px solid rgba(0,170,255,.3); background: rgba(0,170,255,.08); }
                .tm-rec.MARGINAL  { color: #f5a623; border: 1px solid rgba(245,166,35,.3); background: rgba(245,166,35,.08); }
                .tm-score {
                    font-size: 20px; font-weight: 600; color: #f0f4ff;
                }
                .tm-score-sub { font-size: 12px; color: #7a8fa8; }
                .tm-spacer { flex: 1; }

                /* Interval toggle */
                .tm-intervals { display: flex; gap: 4px; }
                .tm-ivbtn {
                    font-family: inherit; font-size: 11px; font-weight: 600;
                    letter-spacing: .08em; text-transform: uppercase;
                    padding: 5px 16px; border-radius: 3px;
                    border: 1px solid #2a3342; background: transparent;
                    color: #7a8fa8; cursor: pointer; transition: all .15s;
                }
                .tm-ivbtn:hover    { color: #f0f4ff; border-color: #f0f4ff; }
                .tm-ivbtn.active   { background: #1fdf7f1a; border-color: #1fdf7f; color: #1fdf7f; }

                /* Close button */
                .tm-close {
                    font-family: inherit; font-size: 18px; line-height: 1;
                    background: transparent; border: none; color: #7a8fa8;
                    cursor: pointer; padding: 4px 8px; border-radius: 3px;
                    transition: color .15s;
                }
                .tm-close:hover { color: #f04040; }

                /* ── Body: chart + panel ── */
                .tm-body {
                    display: flex; flex: 1; min-height: 0; overflow: hidden;
                }
                .tm-chart {
                    flex: 1; min-width: 0; position: relative;
                }

                /* ── Context panel ── */
                .tm-panel {
                    width: 380px; flex-shrink: 0;
                    background: #13161b;
                    border-left: 1px solid #1f2530;
                    overflow-y: auto;
                    padding: 0;
                }
                .tm-panel::-webkit-scrollbar { width: 4px; }
                .tm-panel::-webkit-scrollbar-track { background: #0d0f12; }
                .tm-panel::-webkit-scrollbar-thumb { background: #2a3342; border-radius: 2px; }

                .tm-section {
                    padding: 18px 20px;
                    border-bottom: 1px solid #1f2530;
                }
                .tm-section-title {
                    font-size: 13px; font-weight: 600; letter-spacing: .12em;
                    text-transform: uppercase; color: #7a8fa8;
                    margin-bottom: 14px;
                }

                /* Status badge in panel */
                .tm-status-badge {
                    display: inline-block;
                    font-size: 14px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
                    padding: 5px 14px; border-radius: 2px;
                }
                .tm-status-badge.GO      { background: rgba(31,223,127,.12); color: #1fdf7f;  border: 1px solid rgba(31,223,127,.3); }
                .tm-status-badge.WATCH   { background: rgba(245,166,35,.12); color: #f5a623;  border: 1px solid rgba(245,166,35,.3); }
                .tm-status-badge.BROKEN  { background: rgba(240,64,64,.12);  color: #f04040;  border: 1px solid rgba(240,64,64,.3);  }
                .tm-status-badge.NO_DATA { background: rgba(85,102,119,.12); color: #7a8fa8;  border: 1px solid rgba(85,102,119,.3); }
                .tm-status-badge.ENTERED { background: rgba(0,170,255,.12);  color: #00aaff;  border: 1px solid rgba(0,170,255,.3);  }
                .tm-status-badge.PAUSED  { background: rgba(106,122,138,.1); color: #6a7a8a;  border: 1px solid rgba(106,122,138,.3); }
                .tm-status-badge.WALKED,
                .tm-status-badge.EXPIRED { background: rgba(85,102,119,.1); color: #7a8fa8;  border: 1px solid rgba(85,102,119,.3); }

                /* Data rows */
                .tm-row {
                    display: flex; justify-content: space-between; align-items: baseline;
                    margin-bottom: 11px;
                }
                .tm-row:last-child { margin-bottom: 0; }
                .tm-row-label {
                    font-size: 14px; color: #7a8fa8; letter-spacing: .05em;
                    text-transform: uppercase; flex-shrink: 0;
                }
                .tm-row-val {
                    font-size: 20px; font-weight: 600; color: #f0f4ff;
                    text-align: right;
                }
                .tm-row-val.go     { color: #1fdf7f; }
                .tm-row-val.watch  { color: #f5a623; }
                .tm-row-val.bad    { color: #f04040; }
                .tm-row-val.sub    { color: #b8c8d8; font-size: 17px; font-weight: 400; }

                /* Live best contract */
                .tm-lc-header {
                    display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
                }
                .tm-lc-badge {
                    font-size: 13px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
                    padding: 4px 12px; border-radius: 2px;
                }
                .tm-lc-badge.ok      { background: rgba(31,223,127,.12); color: #1fdf7f; border: 1px solid rgba(31,223,127,.3); }
                .tm-lc-badge.drifted { background: rgba(245,166,35,.12); color: #f5a623; border: 1px solid rgba(245,166,35,.3); }

                .tm-no-data {
                    font-size: 14px; color: #7a8fa8; font-style: italic;
                    padding: 40px 20px; text-align: center; line-height: 1.6;
                }
            `}</style>

            {/* Overlay — click outside to close */}
            <div className="tm-overlay" onClick={onClose}>
                <div className="tm-modal" onClick={e => e.stopPropagation()}>

                    {/* ── Header ── */}
                    <div className="tm-header">
                        <span className="tm-ticker">{ticker}</span>
                        {hasProspect && prospect.recommendation && (
                            <span className={`tm-rec ${prospect.recommendation}`}>
                                {prospect.recommendation}
                            </span>
                        )}
                        {hasProspect && prospect.score != null && (
                            <span className="tm-score">
                                {Number(prospect.score).toFixed(1)}
                                <span className="tm-score-sub">/10</span>
                            </span>
                        )}
                        <div className="tm-spacer" />
                        <div className="tm-intervals">
                            {[['D','Daily'],['60','1H'],['W','Weekly']].map(([iv, label]) => (
                                <button
                                    key={iv}
                                    className={`tm-ivbtn${interval === iv ? ' active' : ''}`}
                                    onClick={() => setIntervalVal(iv)}
                                >{label}</button>
                            ))}
                        </div>
                        <button className="tm-close" onClick={onClose} title="Close (Esc)">✕</button>
                    </div>

                    {/* ── Body ── */}
                    <div className="tm-body">
                        {/* Chart */}
                        <div className="tm-chart">
                            <TradingViewChart ticker={ticker} interval={interval} />
                        </div>

                        {/* Context panel */}
                        <div className="tm-panel">
                            {hasProspect
                                ? <ProspectPanel p={prospect} bk={bk} />
                                : <div className="tm-no-data">No prospect data available for {ticker}.</div>
                            }
                        </div>
                    </div>

                </div>
            </div>
        </>
    );
}

// ── Badge key helper (same logic as ProspectsTab) ───────────────────────────
function badgeKey(c) {
    if (c.paused) return 'PAUSED';
    const s = (c.status || '').toUpperCase();
    if (s && s !== 'PENDING') return s;
    return (c.overall_status || 'NO_DATA').toUpperCase();
}

// ── Prospect context panel ──────────────────────────────────────────────────
function ProspectPanel({ p, bk }) {
    const lc = p.live_contract;
    const hasLC = lc && lc.drift_status;

    // IV as percentage
    const ivPct = p.iv != null ? (Number(p.iv) * 100).toFixed(1) + '%' : '—';
    const lcIvPct = hasLC && lc.iv != null ? (Number(lc.iv) * 100).toFixed(1) + '%' : null;

    // Expiry display: "06/18 (27d)"
    const exp = p.expiration_date
        ? String(p.expiration_date).slice(5, 10).replace('-', '/')
        : '—';
    const dte = p.dte != null ? ` (${p.dte}d)` : '';

    // Stock prices
    const snapPrice = p.stock_price_snapshot != null ? `$${f2(p.stock_price_snapshot)}` : '—';
    const livePrice = p.stock_price         != null ? `$${f2(p.stock_price)}` : null;

    // Call floor vs live mid color
    const midOk = p.call_mid != null && p.call_floor != null;
    const midCls = midOk
        ? (p.call_mid < p.call_floor ? 'bad' : p.call_mid / p.call_floor < 1.02 ? 'watch' : 'go')
        : '';

    return (
        <>
            {/* ── Status ── */}
            <div className="tm-section">
                <div className="tm-section-title">Status</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className={`tm-status-badge ${bk}`}>{bk}</span>
                    {p.captured_at && (
                        <span style={{ fontSize: 15, color: '#7a8fa8' }}>
                            polled {new Date(p.captured_at).toLocaleTimeString('en-US', {
                                hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York'
                            })} ET
                        </span>
                    )}
                </div>
            </div>

            {/* ── Stock price ── */}
            <div className="tm-section">
                <div className="tm-section-title">Stock Price</div>
                <div className="tm-row">
                    <span className="tm-row-label">Snapshot</span>
                    <span className="tm-row-val">{snapPrice}</span>
                </div>
                {livePrice && (
                    <div className="tm-row">
                        <span className="tm-row-label">Live</span>
                        <span className="tm-row-val go">{livePrice}</span>
                    </div>
                )}
                <div className="tm-row">
                    <span className="tm-row-label">Entry Limit</span>
                    <span className="tm-row-val">{p.stock_ceiling != null ? `$${f2(p.stock_ceiling)}` : '—'}</span>
                </div>
            </div>

            {/* ── Recommended contract ── */}
            <div className="tm-section">
                <div className="tm-section-title">Recommended Contract</div>
                <div className="tm-row">
                    <span className="tm-row-label">Strike</span>
                    <span className="tm-row-val">{p.strike != null ? `$${f2(p.strike)}` : '—'}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Expiration</span>
                    <span className="tm-row-val sub">{exp}{dte}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Delta</span>
                    <span className="tm-row-val sub">δ{d3(p.delta)}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">IV</span>
                    <span className="tm-row-val sub">{ivPct}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">IVR</span>
                    <span className="tm-row-val sub">{p.ivr != null ? Number(p.ivr).toFixed(0) : '—'}</span>
                </div>
            </div>

            {/* ── Call pricing ── */}
            <div className="tm-section">
                <div className="tm-section-title">Call Pricing</div>
                <div className="tm-row">
                    <span className="tm-row-label">Report Mid</span>
                    <span className="tm-row-val">{p.premium_mid != null ? `$${f2(p.premium_mid)}` : '—'}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Call Floor</span>
                    <span className="tm-row-val">{p.call_floor != null ? `$${f2(p.call_floor)}` : '—'}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Live Mid</span>
                    <span className={`tm-row-val ${midCls}`}>
                        {p.call_mid != null ? `$${f2(p.call_mid)}` : '—'}
                    </span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Bid / Ask</span>
                    <span className="tm-row-val sub">
                        {p.call_bid != null ? `$${f2(p.call_bid)}` : '—'} / {p.call_ask != null ? `$${f2(p.call_ask)}` : '—'}
                    </span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Open Int</span>
                    <span className="tm-row-val sub">{p.open_interest ?? '—'}</span>
                </div>
            </div>

            {/* ── Trade math ── */}
            <div className="tm-section">
                <div className="tm-section-title">Trade Math</div>
                <div className="tm-row">
                    <span className="tm-row-label">Yield (ann)</span>
                    <span className="tm-row-val go">{pct(p.annualized_yield)}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Breakeven</span>
                    <span className="tm-row-val">{p.breakeven != null ? `$${f2(p.breakeven)}` : '—'}</span>
                </div>
                <div className="tm-row">
                    <span className="tm-row-label">Cushion</span>
                    <span className="tm-row-val">{pct(p.cushion_pct)}</span>
                </div>
            </div>

            {/* ── Live best contract ── */}
            {hasLC && (
                <div className="tm-section">
                    <div className="tm-section-title">Live Best Contract</div>
                    <div className="tm-lc-header">
                        <span className={`tm-lc-badge ${lc.drift_status.toLowerCase()}`}>
                            {lc.drift_status}
                        </span>
                        {lc.yield_vs_report != null && (
                            <span style={{ fontSize: 15, color: '#b8c8d8' }}>
                                {lc.yield_vs_report}% of report yield
                            </span>
                        )}
                    </div>
                    <div className="tm-row">
                        <span className="tm-row-label">Strike</span>
                        <span className="tm-row-val">{lc.strike != null ? `$${f2(lc.strike)}` : '—'}</span>
                    </div>
                    <div className="tm-row">
                        <span className="tm-row-label">Expiration</span>
                        <span className="tm-row-val sub">
                            {lc.expiration_date ? String(lc.expiration_date).slice(5,10).replace('-','/') : '—'}
                            {lc.dte != null ? ` (${lc.dte}d)` : ''}
                        </span>
                    </div>
                    <div className="tm-row">
                        <span className="tm-row-label">Delta / IV</span>
                        <span className="tm-row-val sub">
                            δ{d3(lc.delta)} / {lcIvPct || '—'}
                        </span>
                    </div>
                    <div className="tm-row">
                        <span className="tm-row-label">Mid</span>
                        <span className="tm-row-val go">{lc.premium_mid != null ? `$${f2(lc.premium_mid)}` : '—'}</span>
                    </div>
                    <div className="tm-row">
                        <span className="tm-row-label">Yield (ann)</span>
                        <span className={`tm-row-val ${lc.drift_status.toLowerCase() === 'ok' ? 'go' : 'watch'}`}>
                            {lc.annualized_yield != null ? `${Number(lc.annualized_yield).toFixed(1)}%` : '—'}
                        </span>
                    </div>
                    {lc.open_interest != null && (
                        <div className="tm-row">
                            <span className="tm-row-label">OI</span>
                            <span className="tm-row-val sub">{lc.open_interest}</span>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
