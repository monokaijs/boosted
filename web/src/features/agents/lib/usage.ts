export type AgentUsage = {
  trackedSince: string | null;
  series: { agentId: string; name: string; buckets: { startDate: string; tokens: number }[] }[];
};

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function usageByDay(usage: AgentUsage, days: number, now = new Date()) {
  const dates = Array.from({ length: days }, (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index));
  const indices = new Map(dates.map((date, index) => [dayKey(date), index]));
  const series = usage.series.map((agent) => {
    const values = dates.map(() => 0);
    for (const bucket of agent.buckets) {
      const index = indices.get(dayKey(new Date(bucket.startDate)));
      if (index !== undefined && Number.isFinite(bucket.tokens) && bucket.tokens > 0) values[index] += bucket.tokens;
    }
    return { agentId: agent.agentId, name: agent.name, values, total: values.reduce((sum, value) => sum + value, 0) };
  });
  return { dates, series, total: series.reduce((sum, agent) => sum + agent.total, 0) };
}

export function usageColor(id: string) {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 65%)`;
}

export function chartCeiling(max: number) {
  if (max <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= max / 4)! * magnitude;
  return step * 4;
}
