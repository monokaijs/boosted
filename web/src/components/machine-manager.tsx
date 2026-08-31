import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle, LogOut, MonitorCog, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { createBoostedApiClient, getActiveApiClient } from "@/lib/api";
import { isMixedContentConnection, normalizeMachineBaseUrl, useMachineStore, type MachineProfile } from "@/lib/machines";
import { cn } from "@/lib/utils";

type MachineFormProps = {
  editing?: MachineProfile;
  onDone: () => void;
};

function connectionMessage(error: unknown, baseUrl: string) {
  if (isMixedContentConnection(baseUrl)) {
    return "This HTTPS page cannot connect to a plain-HTTP server. Open Boosted over HTTP or expose the server through HTTPS.";
  }
  return error instanceof Error ? error.message : "Unable to connect to that Boosted server.";
}

function MachineForm({ editing, onDone }: MachineFormProps) {
  const profiles = useMachineStore((state) => state.profiles);
  const addProfile = useMachineStore((state) => state.addProfile);
  const updateProfile = useMachineStore((state) => state.updateProfile);
  const setToken = useMachineStore((state) => state.setToken);
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.baseUrl ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const urlChanged = !editing || url.trim().replace(/\/$/, "") !== editing.baseUrl;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    let baseUrl = "";
    try {
      baseUrl = normalizeMachineBaseUrl(url);
      if (profiles.some((profile) => profile.id !== editing?.id && profile.baseUrl === baseUrl)) throw new Error("That server is already saved.");
      setBusy(true);
      if (editing && !urlChanged) {
        await updateProfile(editing.id, { name: name.trim(), baseUrl });
        onDone();
        return;
      }
      const staged: MachineProfile = {
        id: editing?.id ?? crypto.randomUUID(),
        name: name.trim(),
        baseUrl,
        createdAt: editing?.createdAt ?? new Date().toISOString(),
      };
      let token: string | undefined;
      const client = createBoostedApiClient({ profile: staged, getToken: () => token });
      await client.health(AbortSignal.timeout(8_000));
      const setup = await client.setupState();
      if (setup.needsSetup) throw new Error("This server has not been configured. Create its administrator from its local web or desktop app first.");
      const session = await client.login(username.trim(), password);
      token = session.token;
      if (editing) {
        await updateProfile(editing.id, { name: staged.name, baseUrl });
        await setToken(editing.id, session.token);
      } else {
        await addProfile(staged, session.token);
      }
      onDone();
    } catch (caught) {
      setError(connectionMessage(caught, baseUrl || url));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <label className="grid gap-1.5"><span className="settings-label">Machine name</span><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Studio PC" required /></label>
      <label className="grid gap-1.5"><span className="settings-label">Server URL</span><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="192.168.1.20:4782" autoCapitalize="none" autoCorrect="off" required /></label>
      {urlChanged && <div className="grid gap-3 rounded-lg border border-border bg-background/35 p-3"><p className="text-[11px] text-muted-foreground">Boosted will test the server and sign in before saving this connection.</p><label className="grid gap-1.5"><span className="settings-label">Username</span><Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label className="grid gap-1.5"><span className="settings-label">Password</span><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label></div>}
      {error && <p className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onDone}>Cancel</Button><Button disabled={busy || !name.trim() || !url.trim() || (urlChanged && (!username.trim() || !password))}>{busy && <LoaderCircle className="animate-spin" />}{editing ? "Save" : "Add machine"}</Button></div>
    </form>
  );
}

export function ConnectionsManager({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const profiles = useMachineStore((state) => state.profiles);
  const activeId = useMachineStore((state) => state.activeId);
  const tokens = useMachineStore((state) => state.tokens);
  const setActive = useMachineStore((state) => state.setActive);
  const removeProfile = useMachineStore((state) => state.removeProfile);
  const setToken = useMachineStore((state) => state.setToken);
  const [form, setForm] = useState<"add" | MachineProfile>();

  async function signOut(profileId: string) {
    try {
      await getActiveApiClient().logout();
    } catch {
      // Always allow local sign-out if the machine cannot be reached.
    } finally {
      await setToken(profileId);
    }
  }

  if (form) return <div className={cn(!embedded && "p-1")}><MachineForm editing={form === "add" ? undefined : form} onDone={() => setForm(undefined)} /></div>;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="settings-card flex items-center gap-3">
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground", profile.id === activeId && "bg-primary/10 text-primary")}><Server className="size-4" /></span>
            <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-xs font-medium">{profile.name}{profile.id === activeId && <Check className="size-3 text-success" />}</span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{profile.baseUrl}</span></span>
            {profile.id !== activeId && <Button variant="secondary" size="sm" onClick={() => void setActive(profile.id)}>Switch</Button>}
            {profile.id === activeId && tokens[profile.id] && <Button variant="ghost" size="icon-sm" title="Sign out" onClick={() => void signOut(profile.id)}><LogOut /></Button>}
            <Button variant="ghost" size="icon-sm" title="Edit machine" onClick={() => setForm(profile)}><Pencil /></Button>
            <Button variant="ghost" size="icon-sm" title="Remove machine" onClick={() => { if (window.confirm(`Remove ${profile.name} from this device?`)) void removeProfile(profile.id); }}><Trash2 /></Button>
          </div>
        ))}
        {profiles.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">No Boosted machines have been added.</p>}
      </div>
      <div className="flex justify-between gap-2"><Button variant="secondary" onClick={() => setForm("add")}><Plus />Add machine</Button>{onClose && <Button variant="ghost" onClick={onClose}>Done</Button>}</div>
    </div>
  );
}

export function ConnectionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="connections-dialog max-w-xl"><DialogHeader><DialogTitle>Boosted machines</DialogTitle><DialogDescription>Each connection has its own account, projects, tasks, and session.</DialogDescription></DialogHeader><ConnectionsManager onClose={() => onOpenChange(false)} /></DialogContent></Dialog>;
}

export function MachineSwitcher({ children, onManage }: { children?: ReactNode; onManage?: () => void }) {
  const profiles = useMachineStore((state) => state.profiles);
  const activeId = useMachineStore((state) => state.activeId);
  const setActive = useMachineStore((state) => state.setActive);
  const active = useMemo(() => profiles.find((profile) => profile.id === activeId), [activeId, profiles]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children ?? <Button variant="ghost" size="sm" className="machine-switcher max-w-48" aria-label={active?.name ?? "Machines"} title={active?.name ?? "Machines"}><Server /><span className="machine-switcher-label truncate">{active?.name ?? "Machines"}</span><ChevronDown className="machine-switcher-chevron" /></Button>}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Boosted machine</DropdownMenuLabel>
        {profiles.map((profile) => <DropdownMenuItem key={profile.id} onClick={() => void setActive(profile.id)}><Server /><span className="min-w-0 flex-1"><span className="block truncate">{profile.name}</span><span className="block truncate font-mono text-[9px] text-muted-foreground">{profile.baseUrl}</span></span>{profile.id === activeId && <Check />}</DropdownMenuItem>)}
        {onManage && <><DropdownMenuSeparator /><DropdownMenuItem onClick={onManage}><MonitorCog />Manage machines</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EmptyMachineScreen() {
  return <main className="grid h-full place-items-center bg-background p-5"><section className="grid w-full max-w-lg gap-5 rounded-2xl border border-border bg-card p-5 shadow-2xl"><div className="grid gap-2"><div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Server className="size-5" /></div><h1 className="text-xl font-semibold">Connect to Boosted</h1><p className="text-sm leading-6 text-muted-foreground">Add an already-configured Boosted server to control its projects and tasks from this device.</p></div><ConnectionsManager embedded /></section></main>;
}
