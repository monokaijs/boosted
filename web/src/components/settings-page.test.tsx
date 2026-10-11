import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { selectedProjectId: "project-a" as string | undefined, activeMachineId: "machine-a", user: { id: "user-a", role: "admin" } },
  projects: vi.fn(), globalSettings: vi.fn(), updateGlobalSettings: vi.fn(), setupState: vi.fn(),
  gitlabConnections: vi.fn(), createGitlabConnection: vi.fn(), updateGitlabConnection: vi.fn(), deleteGitlabConnection: vi.fn(),
  integrations: vi.fn(), workspaceCodexSettings: vi.fn(), updateWorkspaceCodexSettings: vi.fn(), usage: vi.fn(), featureRequest: vi.fn(), users: vi.fn(),
  presets: vi.fn(), updatePresets: vi.fn(), codexModelCatalog: vi.fn(), providers: vi.fn(), accounts: vi.fn(), limits: vi.fn(), models: vi.fn(), createAccount: vi.fn(), getAccount: vi.fn(), updateAccount: vi.fn(), deleteAccount: vi.fn(), authenticateAccount: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/api-context", () => ({ useBoostedApiClient: () => ({ profileId: "machine-a", featureRequest: mocks.featureRequest }) }));
vi.mock("@/lib/store", () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock("@/lib/updater", () => ({ useAppUpdateState: () => ({ phase: "idle", supported: true, currentVersion: "0.4.0" }), refreshAppUpdateAvailability: vi.fn(), checkAndInstallAppUpdate: vi.fn(), formatUpdateProgress: () => undefined }));
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: {
  assistant: { usage: mocks.usage },
  providers: { list: mocks.providers },
  modelPresets: { read: mocks.presets, update: mocks.updatePresets },
  providerAccounts: { list: mocks.accounts, limits: mocks.limits, models: mocks.models, create: mocks.createAccount, get: mocks.getAccount, update: mocks.updateAccount, delete: mocks.deleteAccount, authenticate: mocks.authenticateAccount },
} }));

import { SettingsPage, type SettingsSectionId } from "./settings-page";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { readNotificationSettings } from "@/lib/notifications";
import { initializeTheme } from "@/lib/theme";

const account = { id: "account-a", providerId: "codex", displayName: "Work account", status: "CONNECTED", settings: { codexHome: "/isolated/codex" }, runtimeDefaults: { permissionMode: "default", reasoningEffort: "medium" }, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
function renderPage(initial: SettingsSectionId | undefined = "connections") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const [section, setSection] = useState<SettingsSectionId | undefined>(initial);
    return <SettingsPage section={section} onSectionChange={setSection} onBack={() => setSection(undefined)} onClose={mocks.close} />;
  }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}
function renderProjectSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const project = { id: "project-a", name: "Example", repoPath: "/repo/example", defaultBranch: "main", createdAt: "2026-10-01" };
  return render(<QueryClientProvider client={client}><ProjectSettingsDialog project={project} open onOpenChange={() => {}} /></QueryClientProvider>);
}
function selectSection(name: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name })); }
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.state.selectedProjectId = "project-a";
  mocks.state.user.role = "admin";
  mocks.projects.mockResolvedValue([{ id: "project-a", name: "Example", repoPath: "/repo/example", defaultBranch: "main" }]);
  mocks.globalSettings.mockResolvedValue({ webPort: 4782, webUiEnabled: true, allowedIps: [] });
  mocks.updateGlobalSettings.mockImplementation(async (settings) => settings);
  mocks.setupState.mockResolvedValue({ codex: { available: true, authenticated: true, version: "0.159.3" } });
  mocks.integrations.mockResolvedValue([]);
  mocks.gitlabConnections.mockResolvedValue([]);
  mocks.workspaceCodexSettings.mockResolvedValue({ instructions: "Follow repository conventions.", mcps: [] });
  mocks.usage.mockResolvedValue({ trackedSince: null, series: [] });
  mocks.featureRequest.mockResolvedValue([]);
  mocks.users.mockResolvedValue([{ id: "user-a", username: "Admin", role: "admin", disabled: false }]);
  mocks.providers.mockResolvedValue([{ id: "codex", label: "OpenAI Codex", icon: "codex", capabilities: ["models", "auth"], runtimeFields: [{ key: "model" }, { key: "reasoningEffort" }, { key: "serviceTier" }, { key: "permissionMode" }], accountFields: [{ key: "codexHome" }], defaultSettings: { accountsHome: "/isolated", sharedChatHome: "~/.codex" } }]);
  mocks.accounts.mockResolvedValue([account]);
  mocks.presets.mockResolvedValue({ default: { model: "", reasoningEffort: "" }, providers: {} });
  mocks.updatePresets.mockImplementation(async (value) => value);
  mocks.codexModelCatalog.mockResolvedValue({ models: [], defaultModel: "" });
  mocks.limits.mockResolvedValue({ data: {}, errors: {} });
  mocks.models.mockResolvedValue({ data: [{ id: "model-a", model: "model-a", displayName: "Model A" }] });
  mocks.updateAccount.mockImplementation(async (_id, patch) => ({ ...account, ...patch }));
  mocks.createAccount.mockImplementation(async ({ providerId }) => ({ ...account, id: `new-${providerId}`, providerId, displayName: providerId === "claude" ? "Anthropic Claude account" : "OpenAI Codex account", status: "DISCONNECTED", settings: {}, runtimeDefaults: {} }));
  mocks.getAccount.mockResolvedValue(account);
  mocks.deleteAccount.mockResolvedValue(undefined);
  mocks.authenticateAccount.mockResolvedValue({ accountId: "account-a", status: "CONNECTED" });
});

describe("settings page", () => {
  it("keeps shared GitLab setup in machine settings and imports in project settings", async () => {
    const page = renderPage("integrations");
    expect(await screen.findByRole("heading", { name: "GitLab connections" })).toBeInTheDocument();
    expect(screen.getByText("Machine settings")).toBeInTheDocument();
    expect(mocks.integrations).not.toHaveBeenCalled();
    page.unmount();
    renderProjectSettings();
    expect(await screen.findByRole("heading", { name: "Project details" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Installed integrations" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Installed integrations" })).toBeInTheDocument();
    expect(mocks.integrations).toHaveBeenCalledWith("project-a");
    expect(screen.queryByRole("heading", { name: "GitLab connections" })).not.toBeInTheDocument();
    expect(await screen.findAllByText(/Add a GitLab connection in Settings/)).toHaveLength(1);
  });

  it("places analytics under Settings and mounts only the selected usage scope", async () => {
    renderPage("usage");
    expect(await screen.findByText("No recorded usage in this period.")).toBeInTheDocument();
    expect(mocks.usage).toHaveBeenCalledWith(30);
    expect(mocks.featureRequest).not.toHaveBeenCalled();
    expect(mocks.workspaceCodexSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(await screen.findByText("Create a group to start tracking its usage.")).toBeInTheDocument();
    expect(mocks.featureRequest).toHaveBeenCalledWith("/groups", { method: "GET" });
    fireEvent.click(screen.getByRole("tab", { name: "Shared Codex" }));
    expect(await screen.findByRole("heading", { name: "Quota windows" })).toBeInTheDocument();
    expect(mocks.workspaceCodexSettings).toHaveBeenCalledWith("project-a");
  });

  it("separates Codex instructions from tools and connection while retaining edited instructions", async () => {
    renderProjectSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    const instructions = await screen.findByRole("textbox", { name: "Instructions" });
    await waitFor(() => expect(instructions).toHaveValue("Follow repository conventions."));
    fireEvent.change(instructions, { target: { value: "Keep my unsaved instructions." } });
    expect(mocks.setupState).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "MCP servers" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
    expect(await screen.findByRole("heading", { name: "MCP servers" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(mocks.setupState).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Instructions" }));
    expect(await screen.findByRole("textbox", { name: "Instructions" })).toHaveValue("Keep my unsaved instructions.");
  });

  it("renders every section as a page with searchable navigation and a return action", async () => {
    renderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    for (const [label, heading] of [["Usage", "Usage"], ["Providers", "Providers"], ["Connections", "Connections"], ["Appearance", "Appearance"], ["Notifications", "Notifications"], ["Web interface", "Web interface"], ["Application", "Application"], ["Team", "Team"], ["Integrations", "Integrations"]]) {
      selectSection(label);
      expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
      expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
    }
    expect(screen.queryByRole("button", { name: "General" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Codex" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "web" } });
    expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("lets members change the device theme immediately from Appearance", async () => {
    mocks.state.user.role = "member";
    const stopThemeTracking = initializeTheme();
    try {
      renderPage("appearance");
      const theme = screen.getByRole("combobox", { name: "Theme" });
      expect(theme).toHaveTextContent("System");
      fireEvent.keyDown(theme, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: "Dark" }));
      expect(document.documentElement).toHaveClass("dark");
      expect(localStorage.getItem("boosted.theme")).toBe("dark");
      fireEvent.keyDown(theme, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: "Light" }));
      expect(document.documentElement).not.toHaveClass("dark");
      expect(localStorage.getItem("boosted.theme")).toBe("light");
    } finally {
      stopThemeTracking();
      document.documentElement.classList.remove("dark");
      document.documentElement.style.removeProperty("color-scheme");
    }
  });

  it("edits provider defaults inline and saves the chosen permissions", async () => {
    renderPage("providers");
    fireEvent.click(await screen.findByRole("button", { name: /Work account/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const name = await screen.findByRole("textbox", { name: "Account name" });
    await waitFor(() => expect(name).toHaveValue("Work account"));
    fireEvent.change(name, { target: { value: "Personal account" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Access" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Full access" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Model" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Model A" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Model" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Use provider model preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith("account-a", expect.objectContaining({ displayName: "Personal account", runtimeDefaults: expect.objectContaining({ permissionMode: "fullAccess" }) })));
    expect(mocks.updateAccount.mock.calls[0][1].runtimeDefaults).not.toHaveProperty("model");
    fireEvent.click(screen.getByRole("button", { name: "All accounts" }));
    expect(await screen.findByRole("button", { name: /Personal account/ })).toBeInTheDocument();
  });

  it("adds Claude accounts and supports web or API-key authentication", async () => {
    const claudeProvider = { id: "claude", label: "Anthropic Claude", icon: "claude", capabilities: ["models", "auth"], runtimeFields: [{ key: "model" }, { key: "reasoningEffort" }, { key: "permissionMode" }], accountFields: [{ key: "claudeHome" }], defaultSettings: { accountsHome: "/isolated/claude", sharedChatHome: "~/.claude" } };
    const claudeAccount = { ...account, id: "claude-a", providerId: "claude", displayName: "Claude Max", settings: { claudeHome: "/isolated/claude-a" }, lastAuthMode: "web", runtimeDefaults: { permissionMode: "askForApproval" } };
    mocks.providers.mockResolvedValue([
      { id: "codex", label: "OpenAI Codex", icon: "codex", capabilities: ["models", "auth"], runtimeFields: [{ key: "model" }, { key: "reasoningEffort" }, { key: "serviceTier" }, { key: "permissionMode" }], accountFields: [{ key: "codexHome" }], defaultSettings: { accountsHome: "/isolated", sharedChatHome: "~/.codex" } },
      claudeProvider,
    ]);
    mocks.accounts.mockResolvedValue([claudeAccount]);
    mocks.updateAccount.mockImplementation(async (_id, patch) => ({ ...claudeAccount, ...patch }));
    mocks.authenticateAccount.mockResolvedValue({ accountId: "claude-a", status: "CONNECTED", authMode: "apiKey", message: "Anthropic API key saved." });
    renderPage("providers");
    const providerPicker = await screen.findByRole("combobox", { name: "New account provider" });
    await waitFor(() => expect(providerPicker).toHaveTextContent("OpenAI Codex"));
    fireEvent.keyDown(providerPicker, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Anthropic Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledWith({ providerId: "claude" }));

    fireEvent.click(screen.getByRole("button", { name: "All accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: /Claude Max/ }));
    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Authentication" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Anthropic API key" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(mocks.authenticateAccount).toHaveBeenCalledWith("claude-a", { mode: "apiKey", apiKey: "sk-ant-secret" }));
    expect(screen.getByRole("textbox", { name: "Claude home" })).toHaveValue("/isolated/claude-a");
  });

  it("shows connected accounts to members while disabling administrative edits", async () => {
    mocks.state.user.role = "member";
    renderPage("providers");
    expect(await screen.findByRole("button", { name: "Add account" })).toBeDisabled();
    expect(await screen.findByRole("combobox", { name: "Preset model" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model preset" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: /Work account/ }));
    expect(await screen.findByRole("textbox", { name: "Account name" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Access" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("charts provider quota usage and refreshes it on demand", async () => {
    mocks.accounts.mockResolvedValue([account, { ...account, id: "account-b", displayName: "Edward" }]);
    mocks.limits.mockResolvedValue({ data: { "account-a": { rateLimits: {
      primary: { usedPercent: 35, windowDurationMins: 300 },
      secondary: { usedPercent: 72, windowDurationMins: 10_080 },
    } }, "account-b": { rateLimits: { secondary: { usedPercent: 58, windowDurationMins: 10_080 } } } }, errors: {} });
    renderPage("providers");
    const chart = await screen.findByRole("figure", { name: "Provider quota usage" });
    expect(within(chart).getByRole("progressbar", { name: "Work account 5-hour window usage" })).toHaveAttribute("aria-valuenow", "35");
    expect(within(chart).getByRole("progressbar", { name: "Work account 7-day window usage" })).toHaveAttribute("aria-valuenow", "72");
    expect(within(chart).getByRole("progressbar", { name: "Work account 5-hour window usage" }).parentElement).toHaveTextContent(/35%\s*used/);
    expect(within(chart).getByRole("img", { name: "Work account quota usage trend" })).toBeInTheDocument();
    expect(within(chart).getAllByText("Collecting trend data…")).toHaveLength(2);
    const edward = within(chart).getByText("Edward").closest(".provider-usage-account");
    expect(edward).toHaveAttribute("data-limit-count", "1");
    expect(within(edward as HTMLElement).getAllByRole("progressbar")).toHaveLength(1);
    expect(mocks.limits).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider usage" }));
    await waitFor(() => expect(mocks.limits).toHaveBeenCalledTimes(2));
  });

  it("renders a fresh persisted quota snapshot without waiting for the provider request", async () => {
    const savedAt = Date.now();
    const earlier = { "account-a": { rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300 } } } };
    const latest = { "account-a": { rateLimits: { primary: { usedPercent: 48, windowDurationMins: 300 } } } };
    localStorage.setItem("boosted.machine.machine-a.providerQuotas", JSON.stringify({ version: 1, savedAt, value: { data: latest, errors: {} }, history: [{ capturedAt: savedAt - 10 * 60_000, data: earlier }, { capturedAt: savedAt, data: latest }] }));
    mocks.limits.mockImplementation(() => new Promise(() => undefined));
    renderPage("providers");
    expect(await screen.findByRole("progressbar", { name: "Work account 5-hour window usage" })).toHaveAttribute("aria-valuenow", "48");
    const trend = screen.getByRole("img", { name: "Work account quota usage trend" });
    expect(trend.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.queryByText("Collecting trend data…")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading provider usage…")).not.toBeInTheDocument();
    expect(mocks.limits).not.toHaveBeenCalled();
  });

  it("saves the shared model preset and lets a provider override or inherit it", async () => {
    renderPage("providers");
    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Preset model" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Model A" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Preset reasoning" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Low" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Model preset" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Choose provider model" }));
    const provider = within(screen.getByRole("heading", { name: "OpenAI Codex model preset" }).closest("section")!);
    fireEvent.keyDown(provider.getByRole("combobox", { name: "Preset reasoning" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Save model presets" }));
    await waitFor(() => expect(mocks.updatePresets).toHaveBeenCalledWith({ default: { model: "model-a", reasoningEffort: "low" }, providers: { codex: { model: "model-a", reasoningEffort: "high" } } }, expect.anything()));
    expect(await screen.findByRole("status")).toHaveTextContent("Model presets saved.");
    fireEvent.keyDown(provider.getByRole("combobox", { name: "Model preset" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Use default preset" }));
    expect(provider.queryByRole("combobox", { name: "Preset model" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save model presets" }));
    await waitFor(() => expect(mocks.updatePresets).toHaveBeenLastCalledWith({ default: { model: "model-a", reasoningEffort: "low" }, providers: {} }, expect.anything()));
  });

  it("retains the preset draft when saving fails", async () => {
    mocks.updatePresets.mockRejectedValueOnce(new Error("Could not save presets"));
    renderPage("providers");
    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Preset reasoning" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Low" }));
    fireEvent.click(screen.getByRole("button", { name: "Save model presets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save presets");
    expect(screen.getByRole("combobox", { name: "Preset reasoning" })).toHaveTextContent("Low");
    expect(screen.getByRole("button", { name: "Save model presets" })).toBeEnabled();
  });

  it("keeps agent notification choices and validates web settings before saving", async () => {
    renderPage("notifications");
    fireEvent.click(screen.getByRole("switch", { name: "Agent replies" }));
    expect(readNotificationSettings("machine-a").events).not.toContain("agentMessage");
    selectSection("Web interface");
    const port = await screen.findByRole("spinbutton", { name: "Listening port" });
    await waitFor(() => expect(port).toHaveValue(4782));
    fireEvent.change(port, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(port, { target: { value: "9000" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed remote IPs" }), { target: { value: "192.0.2.10\n2001:db8::10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.updateGlobalSettings).toHaveBeenCalledWith({ webPort: 9000, webUiEnabled: true, allowedIps: ["192.0.2.10", "2001:db8::10"] }));
  });

  it("opens mobile categories as individual screens and restores focus on back", async () => {
    vi.stubGlobal("innerWidth", 393);
    mocks.state.selectedProjectId = undefined;
    renderPage("connections");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(mocks.workspaceCodexSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Codex$/ })).not.toBeInTheDocument();
    const category = screen.getByRole("button", { name: /^Notifications$/ });
    fireEvent.click(category);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: /^Notifications$/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /^Notifications$/ }));
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
