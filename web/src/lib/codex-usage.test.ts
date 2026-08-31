import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent, formatWindowDuration, rateLimitBuckets, rateLimitLabel } from "./codex-usage";

describe("Codex usage formatting", () => {
  it("formats exact durations without dropping remainder units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(3_665)).toBe("1h 1m 5s");
    expect(formatDuration(null)).toBe("Unavailable");
  });

  it("uses human-readable quota window lengths", () => {
    expect(formatWindowDuration(15)).toBe("15-minute window");
    expect(formatWindowDuration(300)).toBe("5-hour window");
    expect(formatWindowDuration(10_080)).toBe("7-day window");
  });

  it("preserves fractional usage percentages", () => {
    expect(formatPercent(42.25)).toBe("42.25%");
    expect(formatPercent(null)).toBe("Unavailable");
  });

  it("prefers the multi-bucket rate-limit response without duplicating the legacy bucket", () => {
    const codex = { limitId: "codex", limitName: null };
    const other = { limitId: "codex_other", limitName: "Other models" };
    expect(rateLimitBuckets({ rateLimits: codex, rateLimitsByLimitId: { codex, codex_other: other } })).toEqual([codex, other]);
    expect(rateLimitBuckets({ rateLimits: codex })).toEqual([codex]);
    expect(rateLimitBuckets(null)).toEqual([]);
    expect(rateLimitLabel(codex)).toBe("Codex");
    expect(rateLimitLabel(other)).toBe("Other models");
  });
});
