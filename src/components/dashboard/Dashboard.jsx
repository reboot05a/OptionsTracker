import React from 'react';
import { formatCurrency, formatPercent } from '../../utils/formatters';

const KpiCard = ({ label, value, subtext, valueClassName = '' }) => (
    <div className="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between min-h-[88px]">
        <span className="text-slate-500 dark:text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</span>
        <div className={`text-2xl font-bold font-mono mt-1 ${valueClassName}`}>
            {value}
        </div>
        <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{subtext}</div>
    </div>
);

export const Dashboard = ({ stats }) => {
    const realizedPnL = stats.totalPremiumCollected ?? 0;
    const rolledCount = stats.rolledCount ?? 0;
    const bestTicker = stats.bestTicker;

    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard
                label="Realized P/L"
                value={formatCurrency(realizedPnL)}
                valueClassName={realizedPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}
                subtext={`${stats.closedTradesCount} closed · net after closes`}
            />

            <KpiCard
                label="Win Rate"
                value={formatPercent(stats.winRate)}
                valueClassName="text-indigo-600 dark:text-indigo-400"
                subtext={`${stats.resolvedChains} resolved chains`}
            />

            <KpiCard
                label="Avg ROI"
                value={formatPercent(stats.avgRoi)}
                valueClassName={stats.avgRoi >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}
                subtext="per completed trade"
            />

            <KpiCard
                label="Rolls Taken"
                value={rolledCount}
                valueClassName={rolledCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}
                subtext="defensive rolls across all chains"
            />

            <KpiCard
                label="Best Ticker"
                value={bestTicker ? bestTicker.ticker : '—'}
                valueClassName="text-emerald-600 dark:text-emerald-400"
                subtext={bestTicker ? formatCurrency(bestTicker.pnl) + ' realized' : 'no closed trades yet'}
            />

            <KpiCard
                label="Open Obligation"
                value={formatCurrency(stats.capitalAtRisk)}
                valueClassName="text-slate-700 dark:text-slate-200"
                subtext={`${stats.openTradesCount} open trade${stats.openTradesCount !== 1 ? 's' : ''} · strike × qty`}
            />
        </div>
    );
};
