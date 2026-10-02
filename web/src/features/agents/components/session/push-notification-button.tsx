import { useBoostedApiClient } from '@/lib/api-context';
import { useState } from 'react';
import { notificationPermission, requestNotificationPermission, readNotificationSettings, writeNotificationSettings } from '@/lib/notifications';
export function PushNotificationButton() {
  const { profileId } = useBoostedApiClient();
  const [enabled, setEnabled] = useState(() => readNotificationSettings(profileId).enabled && notificationPermission() === 'granted');
  const [error, setError] = useState<string>();
  return <div><button aria-label="Toggle agent notifications" aria-pressed={enabled} type="button" className="flex w-full items-center justify-between gap-3 rounded-md text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={async () => {
    const next = !enabled;
    if (next && await requestNotificationPermission() !== 'granted') { setError('Allow notifications in your browser to enable them.'); return; }
    const settings = readNotificationSettings(profileId);
    writeNotificationSettings(profileId, { ...settings, enabled: next, events: next ? [...new Set([...settings.events, "agentMessage" as const])] : settings.events }); setEnabled(next); setError(undefined);
  }}><span>Desktop notifications</span><span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}><span className={`size-4 rounded-full bg-background shadow-sm transition-transform ${enabled ? 'translate-x-4' : ''}`} /></span></button>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div>;
}
