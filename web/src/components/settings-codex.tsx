import { useEffect, useMemo, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from "./settings-primitives";
import { Copy, ExternalLink, LoaderCircle, Plug, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

function collectObjects(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, any> => Boolean(entry) && typeof entry === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["data", "servers", "items", "mcpServers"]) { const found = collectObjects(record[key]); if (found.length) return found; }
  return [];
}

export function CodexSettings() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const user = useAppStore((state) => state.user);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("instructions");
  const loadedInstructions = useRef(false);
  const settings = useQuery({ queryKey: ["workspace-codex-settings", projectId], queryFn: () => api.workspaceCodexSettings(projectId!), enabled: Boolean(projectId), retry: false });
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, enabled: tab === "account", refetchInterval: tab === "account" ? 5_000 : false });
  const [instructions, setInstructions] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpType, setMcpType] = useState<"url" | "command">("url");
  const [mcpValue, setMcpValue] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (settings.data && !loadedInstructions.current) { setInstructions(settings.data.instructions); loadedInstructions.current = true; } }, [settings.data]);
  const save = useMutation({ mutationFn: () => api.updateWorkspaceCodexSettings(projectId!, instructions), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["workspace-codex-settings", projectId] }) });
  const addMcp = useMutation({ mutationFn: () => api.upsertWorkspaceMcp(projectId!, mcpName, mcpType === "url" ? { url: mcpValue } : { command: mcpValue, args: mcpArgs.split(/\s+/).filter(Boolean) }), onSuccess: () => { setMcpName(""); setMcpValue(""); setMcpArgs(""); void queryClient.invalidateQueries({ queryKey: ["workspace-codex-settings", projectId] }); } });
  const login = useMutation({ mutationFn: api.startCodexLogin, onSuccess: () => void setup.refetch() });
  const mcps = useMemo(() => collectObjects(settings.data?.mcps), [settings.data?.mcps]);
  const codex = setup.data?.codex;
  return <div className="settings-content"><Tabs.Root value={tab} onValueChange={setTab}>
    <Tabs.List className="settings-tabs" aria-label="Codex configuration"><Tabs.Tab value="instructions">Instructions</Tabs.Tab><Tabs.Tab value="tools">MCP servers</Tabs.Tab><Tabs.Tab value="account">Connection</Tabs.Tab></Tabs.List>
    {settings.isLoading && <p role="status" className="settings-note">Loading workspace configuration…</p>}
    {settings.error && <p role="alert" className="settings-error">{settings.error.message}</p>}
    <Tabs.Panel value="account">
    <SettingsSection title="Shared Codex account" description="The local Codex CLI account used by workspace tasks.">
      <SettingsGroup><SettingsRow label="Connection" description={codex?.available ? codex?.version ?? "Codex CLI detected" : "Install the Codex CLI on this machine to connect."}><span className={codex?.authenticated ? "text-success" : "text-muted-foreground"}>{codex?.authenticated ? "Ready" : codex?.available ? "Login required" : "Unavailable"}</span></SettingsRow>
      {!codex?.authenticated && codex?.available && <SettingsRow label="Sign in with ChatGPT" description="Connect this machine's shared Codex account."><Button variant="secondary" size="sm" disabled={user?.role !== "admin" || login.isPending} onClick={() => login.mutate()}>{login.isPending && <LoaderCircle className="animate-spin" />}Connect</Button></SettingsRow>}</SettingsGroup>
      {login.error && <p role="alert" className="settings-error">{login.error.message}</p>}
      {login.data && !codex?.authenticated && <div className="settings-auth-code"><p>Open <a href={login.data.verificationUrl} target="_blank" rel="noreferrer">the verification page <ExternalLink className="inline size-3" /></a> and enter this code:</p><Button variant="ghost" type="button" aria-label="Copy device code" onClick={() => { void navigator.clipboard.writeText(login.data!.userCode); setCopied(true); }}><code>{login.data.userCode}</code><Copy className="size-4" /></Button>{copied && <p role="status">Copied</p>}</div>}
    </SettingsSection>
    </Tabs.Panel><Tabs.Panel value="instructions">
    <SettingsSection title="Workspace instructions" description="Included in every planning and execution run in this repository."><SettingsGroup><SettingsRow stacked label="Instructions" description="Repository conventions, required checks, and architecture boundaries."><Textarea className="min-h-44 font-mono" value={instructions} disabled={settings.isLoading || !settings.data} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe how Codex should work in this repository…" /></SettingsRow></SettingsGroup><div className="settings-save-bar"><p>{save.isSuccess ? "Instructions saved." : "Applies to new runs in this workspace."}</p><Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || settings.isLoading || !settings.data}>{save.isPending && <LoaderCircle className="animate-spin" />}Save instructions</Button></div>{save.error && <p role="alert" className="settings-error">{save.error.message}</p>}</SettingsSection>
    </Tabs.Panel><Tabs.Panel value="tools">
    <SettingsSection title="MCP servers" description="Tools available to Codex in this workspace.">
      <div className="settings-mcp-list">{mcps.map((mcp, index) => <div key={String(mcp.name ?? mcp.id ?? index)} className="settings-integration-row"><div className="settings-integration-logo"><Plug /></div><div className="settings-row-copy"><p>{String(mcp.name ?? mcp.id ?? "MCP server")}</p><p>{String(mcp.status ?? mcp.authStatus ?? "Configured")}</p></div>{Array.isArray(mcp.tools) && <span className="settings-value">{mcp.tools.length} tools</span>}</div>)}{!mcps.length && <p className="settings-note">No MCP servers reported for this workspace.</p>}</div>
      <details className="settings-advanced"><summary>Add MCP server</summary><form onSubmit={(event) => { event.preventDefault(); if (!addMcp.isPending) addMcp.mutate(); }}><SettingsGroup><SettingsRow label="Server name"><Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /></SettingsRow><SettingsRow label="Connection type"><SettingsSelect value={mcpType} onValueChange={(value) => setMcpType(value as "url" | "command")} options={[{ value: "url", label: "HTTP URL" }, { value: "command", label: "Command" }]} /></SettingsRow><SettingsRow stacked label={mcpType === "url" ? "Server URL" : "Command"}><Input placeholder={mcpType === "url" ? "https://mcp.example.com" : "npx"} value={mcpValue} onChange={(event) => setMcpValue(event.target.value)} required /></SettingsRow>{mcpType === "command" && <SettingsRow stacked label="Arguments" description="Separate arguments with spaces."><Input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} /></SettingsRow>}</SettingsGroup><div className="settings-save-bar"><p>Saved to .codex/config.toml in this repository.</p><Button size="sm" disabled={addMcp.isPending || !mcpName.trim() || !mcpValue.trim()}>{addMcp.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}Add server</Button></div>{addMcp.error && <p role="alert" className="settings-error">{addMcp.error.message}</p>}</form></details>
    </SettingsSection>
    </Tabs.Panel></Tabs.Root>
  </div>;
}

