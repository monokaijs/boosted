import { describe, expect, it } from 'vitest';
import { chartCeiling, usageByDay } from './usage';

describe('daily agent usage', () => {
  it('groups hourly records in local calendar days and keeps separate, zero-filled agent series', () => {
    const now = new Date(2026, 9, 4, 15);
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const data = usageByDay({ trackedSince: null, series: [
      { agentId: 'pock', name: 'Pock', buckets: [
        { startDate: at(3, 1), tokens: 100 }, { startDate: at(3, 23), tokens: 50 },
        { startDate: at(4, 0), tokens: 25 }, { startDate: at(1, 12), tokens: 999 },
        { startDate: at(5, 12), tokens: 999 }, { startDate: 'invalid', tokens: 999 },
      ] },
      { agentId: 'sage', name: 'Sage', buckets: [{ startDate: at(3, 12), tokens: 40 }] },
      { agentId: 'idle', name: 'Idle', buckets: [] },
    ] }, 3, now);
    expect(data.dates.map((date) => date.getDate())).toEqual([2, 3, 4]);
    expect(data.series.map((agent) => agent.values)).toEqual([[0, 150, 25], [0, 40, 0], [0, 0, 0]]);
    expect(data.series.map((agent) => agent.total)).toEqual([175, 40, 0]);
    expect(data.total).toBe(215);
  });

  it('crosses month boundaries without dropping days', () => {
    const data = usageByDay({ trackedSince: null, series: [] }, 7, new Date(2026, 9, 4));
    expect(data.dates.map((date) => [date.getMonth(), date.getDate()])).toEqual([[8, 28], [8, 29], [8, 30], [9, 1], [9, 2], [9, 3], [9, 4]]);
  });

  it('scales axes for empty, small and large totals', () => {
    expect(chartCeiling(0)).toBe(4);
    for (const max of [1, 3, 120, 200_001, 1_000_000]) {
      expect(chartCeiling(max)).toBeGreaterThanOrEqual(max);
      expect(Number.isFinite(chartCeiling(max))).toBe(true);
    }
  });
});
