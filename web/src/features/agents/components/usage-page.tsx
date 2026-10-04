import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesCombined } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '../lib/api-client';
import { chartCeiling, usageByDay, usageColor, type AgentUsage } from '../lib/usage';
import './usage-page.css';

const ranges = [7, 30, 90] as const;
const exact = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
const width = 760;
const height = 300;
const plot = { left: 58, right: 740, top: 22, bottom: 260 };

export function UsagePage() {
  const [days, setDays] = useState<number>(30);
  const usage = useQuery({ queryKey: ['agent-usage', days], queryFn: () => apiClient.assistant.usage(days), refetchInterval: 15_000 });
  return <div className="full-page-scroll usage-page"><div className="page-content">
    <header className="page-heading"><div><h1>Agent usage</h1><p>Daily token consumption, with a separate series for each agent.</p></div></header>
    <div className="usage-toolbar"><span>Tokens over time</span><div className="usage-ranges" role="group" aria-label="Usage time range">{ranges.map((range) => <button key={range} aria-pressed={days === range} onClick={() => setDays(range)}>{range} days</button>)}</div></div>
    {usage.isPending ? <p className="usage-status" role="status">Loading agent usage…</p> : usage.isError ? <div className="usage-status"><p role="alert">Unable to load agent usage. {usage.error.message}</p><Button variant="secondary" size="sm" onClick={() => void usage.refetch()}>Try again</Button></div> : <UsageChart key={days} usage={usage.data} days={days} />}
    <p className="usage-note">Includes input and output tokens from direct and group agent turns. Coding chats launched by agents are excluded. Dates use your local time zone. {usage.data?.trackedSince ? `Recorded since ${shortDate.format(new Date(usage.data.trackedSince))}.` : 'Token tracking starts with new agent activity; earlier usage is unavailable.'}</p>
  </div></div>;
}

function UsageChart({ usage, days }: { usage: AgentUsage; days: number }) {
  const titleId = useId();
  const descriptionId = useId();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState(days - 1);
  const { dates, series, total } = usageByDay(usage, days);
  const visible = series.filter((agent) => !hidden.has(agent.agentId));
  const ceiling = chartCeiling(Math.max(0, ...visible.flatMap((agent) => agent.values)));
  const x = (index: number) => plot.left + index / (days - 1) * (plot.right - plot.left);
  const y = (tokens: number) => plot.bottom - tokens / ceiling * (plot.bottom - plot.top);
  const tickIndices = [...new Set([0, Math.round((days - 1) / 3), Math.round((days - 1) * 2 / 3), days - 1])];
  return <>
    <div className="usage-summary"><strong>{exact.format(total)}</strong><span>tokens in the last {days} days</span></div>
    <div className="usage-chart-card">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const point = (event.clientX - rect.left) / rect.width * width;
        setSelected(Math.max(0, Math.min(days - 1, Math.round((point - plot.left) / (plot.right - plot.left) * (days - 1)))));
      }}>
        <title id={titleId}>Daily token usage by agent</title>
        <desc id={descriptionId}>Line chart for the last {days} days. Each agent has a separate colored series. Use the agent buttons to show or hide series and the day slider to inspect exact values.</desc>
        {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line className="usage-grid" x1={plot.left} x2={plot.right} y1={y(ceiling * tick / 4)} y2={y(ceiling * tick / 4)} /><text className="usage-axis" x={plot.left - 10} y={y(ceiling * tick / 4) + 4} textAnchor="end">{compact.format(ceiling * tick / 4)}</text></g>)}
        {tickIndices.map((index) => <text key={index} className="usage-axis" x={x(index)} y={height - 14} textAnchor={index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle'}>{shortDate.format(dates[index])}</text>)}
        <line className="usage-cursor" x1={x(selected)} x2={x(selected)} y1={plot.top} y2={plot.bottom} />
        {visible.map((agent, index) => <g key={agent.agentId} data-agent-id={agent.agentId}><polyline fill="none" stroke={usageColor(agent.agentId)} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={index % 3 === 0 ? undefined : index % 3 === 1 ? '7 3' : '2 4'} points={agent.values.map((value, day) => `${x(day)},${y(value)}`).join(' ')} /><circle cx={x(selected)} cy={y(agent.values[selected])} r="4" fill={usageColor(agent.agentId)} /></g>)}
      </svg>
      {total === 0 && <p className="usage-empty"><ChartNoAxesCombined aria-hidden="true" />No recorded usage in this period.</p>}
      <div className="usage-inspector"><label htmlFor={`${titleId}-day`}>Inspect day</label><input id={`${titleId}-day`} type="range" min={0} max={days - 1} value={selected} onChange={(event) => setSelected(Number(event.target.value))} aria-valuetext={fullDate.format(dates[selected])} /></div>
      <div className="usage-day-details" aria-live="polite" aria-atomic="true"><strong>{fullDate.format(dates[selected])}</strong><div>{visible.length ? visible.map((agent) => <span key={agent.agentId}><i style={{ background: usageColor(agent.agentId) }} />{agent.name}<b>{exact.format(agent.values[selected])}</b></span>) : <span>Select an agent below to show usage.</span>}</div></div>
    </div>
    {series.length > 0 && <div className="usage-legend" role="group" aria-label="Agent series">{series.map((agent) => <button key={agent.agentId} aria-pressed={!hidden.has(agent.agentId)} onClick={() => setHidden((old) => {
      const next = new Set(old);
      if (next.has(agent.agentId)) next.delete(agent.agentId); else next.add(agent.agentId);
      return next;
    })}><i style={{ background: usageColor(agent.agentId) }} /><span>{agent.name}</span><b>{exact.format(agent.total)}</b><span className="usage-token-label">tokens</span></button>)}</div>}
  </>;
}
