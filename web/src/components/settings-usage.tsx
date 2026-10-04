import { lazy, Suspense, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { SettingsGroup, SettingsRow, SettingsSection } from "./settings-primitives";
import type { CodexRateLimitWindow } from "@/lib/types";
import { formatDuration, formatExactNumber, formatPercent, formatWindowDuration, rateLimitBuckets, rateLimitLabel } from "@/lib/codex-usage";
const UsagePage = lazy(() => import("@/features/agents/components/usage-page").then((m) => ({ default: m.UsagePage })));

function formatDayCount(value?: number | null) {
  if (value === undefined || value === null) return "Unavailable";
  return `${formatExactNumber(value)} ${value === 1 ? "day" : "days"}`;
}

function formatUnixTimestamp(value?: number | null) {
  if (value === undefined || value === null) return "Not provided";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value * 1_000));
}

function QuotaWindow({ name, window }: { name: string; window: CodexRateLimitWindow }) {
  const percentage = window.usedPercent;
  const width = percentage === undefined || percentage === null ? 0 : Math.min(100, Math.max(0, percentage));
  return <div className="settings-quota-window">
    <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-medium">{window.windowDurationMins === undefined || window.windowDurationMins === null ? name : formatWindowDuration(window.windowDurationMins)}</span><strong className="text-xs">{percentage === undefined || percentage === null ? "Usage unavailable" : `${formatPercent(percentage)} used`}</strong></div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${width}%` }} /></div>
    <p className="mt-2 text-[10px] text-muted-foreground">{window.resetsAt === undefined || window.resetsAt === null ? "Reset time unavailable" : `Resets ${formatUnixTimestamp(window.resetsAt)}`}</p>
  </div>;
}

function SharedCodexUsage() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const settings = useQuery({ queryKey: ["workspace-codex-settings", projectId], queryFn: () => api.workspaceCodexSettings(projectId!), enabled: Boolean(projectId), retry: false, refetchInterval: 30_000 });
  const usage = settings.data?.usage;
  const summary = usage?.summary;
  const dailyUsage = usage?.dailyUsageBuckets;
  const limits = rateLimitBuckets(settings.data?.rateLimits);
  const resetCredits = settings.data?.rateLimits?.rateLimitResetCredits;
  if (!projectId) return <p className="settings-empty">Open a workspace to view the shared Codex account’s usage.</p>;
  return <>{settings.isPending && <p role="status" className="settings-note">Loading account usage…</p>}{settings.error && <p role="alert" className="settings-error">{settings.error.message}</p>}
    <SettingsSection title="Usage" description="Token activity reported for the shared Codex account.">
      {summary ? <SettingsGroup><SettingsRow label="Lifetime tokens"><span>{formatExactNumber(summary.lifetimeTokens)}</span></SettingsRow><SettingsRow label="Peak daily tokens"><span>{formatExactNumber(summary.peakDailyTokens)}</span></SettingsRow><SettingsRow label="Longest turn"><span>{formatDuration(summary.longestRunningTurnSec)}</span></SettingsRow><SettingsRow label="Current streak"><span>{formatDayCount(summary.currentStreakDays)}</span></SettingsRow><SettingsRow label="Longest streak"><span>{formatDayCount(summary.longestStreakDays)}</span></SettingsRow></SettingsGroup> : <p className="settings-note">Token activity is unavailable for this account.</p>}
      {dailyUsage && dailyUsage.length > 0 && <details className="settings-advanced"><summary>Daily token activity <span className="settings-inline-meta">{dailyUsage.length} days</span></summary><SettingsGroup>{dailyUsage.map((bucket) => <SettingsRow key={bucket.startDate} label={bucket.startDate}><span>{formatExactNumber(bucket.tokens)} tokens</span></SettingsRow>)}</SettingsGroup></details>}
    </SettingsSection>
    <SettingsSection title="Quota windows" description="Reported usage and exact local reset times.">
      {limits.length ? <div className="settings-quota-list">{limits.map((limit) => <div key={limit.limitId}><div className="settings-quota-title"><p>{rateLimitLabel(limit)}</p>{limit.planType && <span>{limit.planType}</span>}</div><div className="settings-group">{limit.primary && <QuotaWindow name="Primary window" window={limit.primary} />}{limit.secondary && <QuotaWindow name="Secondary window" window={limit.secondary} />}</div>{limit.rateLimitReachedType && <p className="settings-error">{limit.rateLimitReachedType}</p>}</div>)}</div> : <p className="settings-note">Quota-window usage is unavailable for this account.</p>}
    </SettingsSection>
    <SettingsSection title="Banked resets" description="Earned rate-limit resets available on this account."><SettingsGroup><SettingsRow label="Available resets"><span>{resetCredits ? formatExactNumber(resetCredits.availableCount) : "Unavailable"}</span></SettingsRow>{resetCredits?.credits?.map((credit) => <SettingsRow key={credit.id} label={credit.title ?? "Rate-limit reset"} description={<>{credit.description && <>{credit.description}<br /></>}{credit.resetType} · Granted {formatUnixTimestamp(credit.grantedAt)} · {credit.expiresAt ? `Expires ${formatUnixTimestamp(credit.expiresAt)}` : "Does not expire"}</>}><span className="settings-value">{credit.status}</span></SettingsRow>)}</SettingsGroup>{resetCredits && resetCredits.availableCount > (resetCredits.credits?.length ?? 0) && <p className="settings-note">The account reported {resetCredits.availableCount} available resets and returned {resetCredits.credits?.length ?? 0} individual details.</p>}</SettingsSection>
  </>;
}

export function UsageSettings() {
  const [tab, setTab] = useState("agents");
  return <div className="settings-content"><Tabs.Root value={tab} onValueChange={setTab}>
    <Tabs.List className="settings-tabs" aria-label="Usage scope"><Tabs.Tab value="agents">Agents</Tabs.Tab><Tabs.Tab value="groups">Groups</Tabs.Tab><Tabs.Tab value="account">Shared Codex</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="agents"><Suspense fallback={<p role="status">Loading usage…</p>}><UsagePage embedded /></Suspense></Tabs.Panel>
    <Tabs.Panel value="groups"><Suspense fallback={<p role="status">Loading usage…</p>}><UsagePage embedded groups /></Suspense></Tabs.Panel>
    <Tabs.Panel value="account"><SharedCodexUsage /></Tabs.Panel>
  </Tabs.Root></div>;
}

