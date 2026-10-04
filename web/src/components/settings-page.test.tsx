import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { selectedProjectId: "project-a" as string | undefined, activeMachineId: "machine-a", user: { id: "user-a", role: "admin" } },
  projects: vi.fn(), globalSettings: vi.fn(), updateGlobalSettings: vi.fn(), setupState: vi.fn(),
  integrations: vi.fn(), workspaceCodexSettings: vi.fn(), users: vi.fn(),
  providers: vi.fn(), accounts: vi.fn(), limits: vi.fn(), models: vi.fn(), updateAccount: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/store", () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock("@/lib/updater", () => ({ useAppUpdateState: () => ({ phase: "idle", supported: true, currentVersion: "0.4.0" }), refreshAppUpdateAvailability: vi.fn(), checkAndInstallAppUpdate: vi.fn(), formatUpdateProgress: () => undefined }));
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: {
  providers: { list: mocks.providers },
  providerAccounts: { list: mocks.accounts, limits: mocks.limits, models: mocks.models, update: mocks.updateAccount },
} }));

import { SettingsPage, type SettingsSectionId } from "./settings-page";
import { readNotificationSettings } from "@/lib/notifications";

const account = { id: "account-a", providerId: "codex", displayName: "Work account", status: "CONNECTED", settings: { codexHome: "/isolated/codex" }, runtimeDefaults: { permissionMode: "default", reasoningEffort: "medium" }, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
function renderPage(initial: SettingsSectionId = "connections") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const [section, setSection] = useState(initial);
    return <SettingsPage section={section} onSectionChange={setSection} onClose={mocks.close} />;
  }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
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
  mocks.workspaceCodexSettings.mockResolvedValue({ instructions: "Follow repository conventions.", mcps: [] });
  mocks.users.mockResolvedValue([{ id: "user-a", username: "Admin", role: "admin", disabled: false }]);
  mocks.providers.mockResolvedValue([{ id: "codex", label: "OpenAI Codex", icon: "codex", capabilities: ["models", "auth"], runtimeFields: [{ key: "model" }, { key: "reasoningEffort" }, { key: "serviceTier" }, { key: "permissionMode" }], accountFields: [{ key: "codexHome" }], defaultSettings: { accountsHome: "/isolated", sharedChatHome: "~/.codex" } }]);
  mocks.accounts.mockResolvedValue([account]);
  mocks.limits.mockResolvedValue({ data: {}, errors: {} });
  mocks.models.mockResolvedValue({ data: [{ id: "model-a", model: "model-a", displayName: "Model A" }] });
  mocks.updateAccount.mockImplementation(async (_id, patch) => ({ ...account, ...patch }));
});

describe("settings page", () => {
  it("renders every section as a page with searchable navigation and a return action", async () => {
    renderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    for (const [label, heading] of [["Providers", "Providers"], ["Connections", "Connections"], ["Notifications", "Notifications"], ["Web interface", "Web interface"], ["Application", "Application"], ["Team", "Team"], ["General", "Workspace"], ["Integrations", "Integrations"], ["Codex", "Codex"]]) {
      selectSection(label);
      expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
      expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
    }
    await screen.findByRole("textbox", { name: "Instructions" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "web" } });
    expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.close).toHaveBeenCalledOnce();
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
    fireEvent.click(await screen.findByRole("option", { name: "Automatic (Codex default)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith("account-a", expect.objectContaining({ displayName: "Personal account", runtimeDefaults: expect.objectContaining({ permissionMode: "fullAccess" }) })));
    expect(mocks.updateAccount.mock.calls[0][1].runtimeDefaults).not.toHaveProperty("model");
    fireEvent.click(screen.getByRole("button", { name: "All accounts" }));
    expect(await screen.findByRole("button", { name: /Personal account/ })).toBeInTheDocument();
  });

  it("shows connected accounts to members while disabling administrative edits", async () => {
    mocks.state.user.role = "member";
    renderPage("providers");
    expect(await screen.findByRole("button", { name: "Add account" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: /Work account/ }));
    expect(await screen.findByRole("textbox", { name: "Account name" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Access" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
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

  it("provides a dismissible section drawer and handles a missing workspace", async () => {
    mocks.state.selectedProjectId = undefined;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Browse settings sections" }));
    const drawer = screen.getByRole("dialog", { name: "Settings sections" });
    expect(drawer).toHaveFocus();
    expect(within(drawer).getByRole("textbox", { name: "Search settings" })).not.toHaveFocus();
    fireEvent.click(within(drawer).getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Open a workspace to configure Codex instructions and MCP servers.")).toBeInTheDocument();
    expect(mocks.workspaceCodexSettings).not.toHaveBeenCalled();
  });
});
