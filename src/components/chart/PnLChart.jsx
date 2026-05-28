import React, { useState } from 'react';
import { BarChart2 } from 'lucide-react';
import {
    AreaChart, Area,
    BarChart, Bar,
    XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Cell, ReferenceLine
} from 'recharts';
import { formatCurrency, formatDate } from '../../utils/formatters';

const PERIODS = [
    { key: '1m', label: '1M' },
    { key: '3m', label: '3M' },
    { key: '6m', label: '6M' },
    { key: 'ytd', label: 'YTD' },
    { key: 'all', label: 'All' }
];

const CumulativeTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const data = payload[0].payload;
    return (
        <div className="bg-white dark:bg-slate-800 p-3 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 text-sm">
            <p className="font-semibold text-slate-700 dark:text-slate-200">{data.ticker}</p>
            <p className="text-slate-500 dark:text-slate-400">{formatDate(data.fullDate)}</p>
            <p className={`font-mono font-medium ${data.tradePnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                Trade: {formatCurrency(data.tradePnl)}
            </p>
            <p className={`font-mono font-bold ${data.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                Running total: {formatCurrency(data.pnl)}
            </p>
        </div>
    );
};

const MonthlyTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const val = payload[0].value;
    return (
        <div className="bg-white dark:bg-slate-800 p-3 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 text-sm">
            <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">{label}</p>
            <p className={`font-mono font-bold ${val >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatCurrency(val)}
            </p>
        </div>
    );
};

export const PnLChart = ({
    chartData,
    chartPeriod,
    onPeriodChange,
    totalPnL,
    darkMode,
    monthlyStats = {}
}) => {
    const [view, setView] = useState('monthly');

    // Build monthly bars from monthlyStats, sorted chronologically
    const monthlyData = Object.entries(monthlyStats)
        .map(([month, pnl]) => ({ month, pnl }))
        .sort((a, b) => new Date(a.month) - new Date(b.month));

    const hasData = view === 'monthly' ? monthlyData.length > 0 : chartData.length > 0;
    if (!hasData) return null;

    const chartColor = totalPnL >= 0 ? '#10b981' : '#ef4444';
    const gridColor = darkMode ? '#334155' : '#e2e8f0';
    const tickColor = darkMode ? '#64748b' : '#94a3b8';

    return (
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 p-5">
            <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-slate-400" />
                    {view === 'monthly' ? 'Monthly Income' : 'Cumulative P/L'}
                </h3>
                <div className="flex items-center gap-3">
                    {/* View toggle */}
                    <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-0.5">
                        {[{ key: 'monthly', label: 'Monthly' }, { key: 'cumulative', label: 'Cumulative' }].map(v => (
                            <button
                                key={v.key}
                                onClick={() => setView(v.key)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                    view === v.key
                                        ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                }`}
                            >
                                {v.label}
                            </button>
                        ))}
                    </div>
                    {/* Period selector — only for cumulative */}
                    {view === 'cumulative' && (
                        <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-0.5">
                            {PERIODS.map(period => (
                                <button
                                    key={period.key}
                                    onClick={() => onPeriodChange(period.key)}
                                    className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                                        chartPeriod === period.key
                                            ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                                >
                                    {period.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <span className={`text-sm font-mono font-bold ${totalPnL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {formatCurrency(totalPnL)}
                    </span>
                </div>
            </div>

            <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                    {view === 'monthly' ? (
                        <BarChart data={monthlyData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                            <XAxis
                                dataKey="month"
                                tick={{ fontSize: 11, fill: tickColor }}
                                tickLine={{ stroke: gridColor }}
                                axisLine={{ stroke: gridColor }}
                            />
                            <YAxis
                                tick={{ fontSize: 11, fill: tickColor }}
                                tickLine={{ stroke: gridColor }}
                                axisLine={{ stroke: gridColor }}
                                tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`}
                            />
                            <Tooltip content={<MonthlyTooltip />} />
                            <ReferenceLine y={0} stroke={gridColor} />
                            <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                                {monthlyData.map((entry, i) => (
                                    <Cell
                                        key={i}
                                        fill={entry.pnl >= 0 ? '#10b981' : '#ef4444'}
                                        fillOpacity={0.85}
                                    />
                                ))}
                            </Bar>
                        </BarChart>
                    ) : (
                        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                            <XAxis
                                dataKey="date"
                                tick={{ fontSize: 11, fill: tickColor }}
                                tickLine={{ stroke: gridColor }}
                                axisLine={{ stroke: gridColor }}
                            />
                            <YAxis
                                tick={{ fontSize: 11, fill: tickColor }}
                                tickLine={{ stroke: gridColor }}
                                axisLine={{ stroke: gridColor }}
                                tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`}
                            />
                            <Tooltip content={<CumulativeTooltip />} />
                            <Area
                                type="monotone"
                                dataKey="pnl"
                                stroke={chartColor}
                                strokeWidth={2}
                                fillOpacity={1}
                                fill="url(#colorPnl)"
                            />
                        </AreaChart>
                    )}
                </ResponsiveContainer>
            </div>
        </div>
    );
};
