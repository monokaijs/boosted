import type { CodexRateLimitBucket, CodexRateLimits } from "@/lib/types";

export function formatExactNumber(value?: number | null) {
  return value === undefined || value === null ? "Unavailable" : new Intl.NumberFormat().format(value);
}

export function formatDuration(totalSeconds?: number | null) {
  if (totalSeconds === undefined || totalSeconds === null) return "Unavailable";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const parts = [
    [Math.floor(seconds / 86_400), "d"],
    [Math.floor((seconds % 86_400) / 3_600), "h"],
    [Math.floor((seconds % 3_600) / 60), "m"],
    [seconds % 60, "s"],
  ] as const;
  return parts.filter(([value]) => value > 0).map(([value, unit]) => `${value}${unit}`).join(" ") || "0s";
}

export function formatWindowDuration(minutes?: number | null) {
  if (minutes === undefined || minutes === null) return "Quota window";
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `${days}-day window`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour window`;
  }
  return `${minutes}-minute window`;
}

export function formatPercent(value?: number | null) {
  if (value === undefined || value === null) return "Unavailable";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}%`;
}

export function rateLimitLabel(bucket: CodexRateLimitBucket) {
  if (bucket.limitName) return bucket.limitName;
  if (bucket.limitId === "codex") return "Codex";
  return bucket.limitId.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function rateLimitBuckets(rateLimits?: CodexRateLimits | null) {
  const buckets = Object.values(rateLimits?.rateLimitsByLimitId ?? {});
  if (buckets.length > 0) return buckets;
  return rateLimits?.rateLimits ? [rateLimits.rateLimits] : [];
}
