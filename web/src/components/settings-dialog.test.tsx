import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appState: { selectedProjectId: "workspace-a" as string | undefined, user: { role: "admin" } },
  updateState: { phase: "idle", supported: true, currentVersion: "0.4.0", downloadedBytes: 0, supportReason: undefined as string | undefined },
  checkAndInstallAppUpdate: vi.fn(),
  refreshAppUpdateAvailability: vi.fn(),
  refreshWebApp: vi.fn(),
  isTauriRuntime: vi.fn(),
  gitlabConnections: vi.fn(),
  createGitlabConnection: vi.fn(),
  updateGitlabConnection: vi.fn(),
  deleteGitlabConnection: vi.fn(),
  integrations: vi.fn(),
  discoverIntegrationTargets: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  syncIntegration: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/web-update", () => ({ refreshWebApp: mocks.refreshWebApp }));
vi.mock("@/lib/runtime", () => ({ isTauriRuntime: mocks.isTauriRuntime }));
vi.mock("@/lib/updater", () => ({
  useAppUpdateState: () => mocks.updateState,
  formatUpdateProgress: () => undefined,
  checkAndInstallAppUpdate: mocks.checkAndInstallAppUpdate,
  refreshAppUpdateAvailability: mocks.refreshAppUpdateAvailability,
}));
vi.mock("@/lib/store", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.appState) => unknown) => selector(mocks.appState),
    { getState: () => mocks.appState },
  ),
}));

import { GitlabConnectionsSettings } from "@/components/settings-gitlab";
import { ApplicationSettings, IntegrationsSettings } from "@/components/settings-page";

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationsSettings />
    </QueryClientProvider>,
  );
}

describe("integration target discovery", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appState.selectedProjectId = "workspace-a";
    mocks.integrations.mockResolvedValue([]);
    mocks.gitlabConnections.mockResolvedValue([
      { id: "connection-a", name: "Primary GitLab", baseUrl: "https://gitlab.example", token: "first-token" },
      { id: "connection-b", name: "Second GitLab", baseUrl: "https://other.example", token: "second-token" },
    ]);
    mocks.createGitlabConnection.mockResolvedValue({});
    mocks.updateGitlabConnection.mockResolvedValue({});
    mocks.deleteGitlabConnection.mockResolvedValue(undefined);
    mocks.discoverIntegrationTargets.mockResolvedValue({
      targets: [
        { kind: "group", identifier: "7", name: "Acme", fullPath: "acme" },
        { kind: "project", identifier: "101", name: "Boosted", fullPath: "acme/boosted" },
      ],
    });
    mocks.createIntegration.mockResolvedValue({});
    mocks.updateIntegration.mockResolvedValue({});
    mocks.deleteIntegration.mockResolvedValue(undefined);
    mocks.syncIntegration.mockResolvedValue({ imported: 0, skipped: 0, failed: 0, message: "Done" });
  });

  it("auto-explores the saved connection and clears new selections when the connection changes", async () => {
    renderSettings();
    await screen.findByText("No integrations installed");
    fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));

    await waitFor(() => expect(mocks.discoverIntegrationTargets).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const group = await screen.findByRole("checkbox", { name: /Acme/ });
    fireEvent.click(group);
    expect(screen.getByText("1 target selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect sources" })).toBeEnabled();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "GitLab connection" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Second GitLab" }));

    await waitFor(() => expect(screen.getByText("0 targets selected")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Connect sources" })).toBeDisabled();
  });

  it("aborts stale exploration and ignores its late response", async () => {
    let resolveFirst!: (value: { targets: Array<Record<string, string>> }) => void;
    const firstResult = new Promise<{ targets: Array<Record<string, string>> }>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.discoverIntegrationTargets
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValue({
        targets: [{ kind: "project", identifier: "202", name: "Current", fullPath: "acme/current" }],
      });

    renderSettings();
    await screen.findByText("No integrations installed");
    fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
    await waitFor(() => expect(mocks.discoverIntegrationTargets).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const firstSignal = mocks.discoverIntegrationTargets.mock.calls[0][2] as AbortSignal;

    fireEvent.keyDown(screen.getByRole("combobox", { name: "GitLab connection" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Second GitLab" }));
    await waitFor(() => expect(firstSignal.aborted).toBe(true));
    await waitFor(() => expect(mocks.discoverIntegrationTargets).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await screen.findByRole("checkbox", { name: /Current/ });

    resolveFirst({
      targets: [{ kind: "project", identifier: "101", name: "Stale", fullPath: "acme/stale" }],
    });
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: /Stale/ })).not.toBeInTheDocument());
  });

  it("keeps a legacy path target and external-id mode when editing", async () => {
    mocks.integrations.mockResolvedValue([{
      id: "integration-a",
      projectId: "workspace-a",
      provider: "gitlab",
      name: "Existing GitLab",
      config: {
        connectionId: "connection-a",
        project: "acme/boosted",
      },
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }]);
    renderSettings();
    await screen.findByText("Existing GitLab");
    fireEvent.click(screen.getByTitle("Edit integration"));

    const project = await screen.findByRole("checkbox", { name: /Boosted/ }, { timeout: 2_000 });
    expect(screen.getByText("1 target selected")).toBeInTheDocument();
    await waitFor(() => expect(project).toBeChecked());
    const save = screen.getByRole("button", { name: "Save integration" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(mocks.updateIntegration).toHaveBeenCalledTimes(1));
    expect(mocks.updateIntegration.mock.calls[0][2].config.targets).toEqual([
      { kind: "project", identifier: "acme/boosted", legacyExternalIds: true },
    ]);
  });

  it("searches GitLab remotely while retaining selections from the initial batch", async () => {
    mocks.discoverIntegrationTargets.mockResolvedValueOnce({
      targets: [{ kind: "group", identifier: "7", name: "Acme", fullPath: "acme" }],
      hasMore: true,
    }).mockResolvedValue({ targets: [{ kind: "project", identifier: "999", name: "Rare", fullPath: "acme/rare" }] });
    renderSettings();
    await screen.findByText("No integrations installed");
    fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Acme/ }, { timeout: 2_000 }));
    expect(screen.getByText(/Showing the first 10/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search integration targets" }), { target: { value: "Rare" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Rare/ }, { timeout: 2_000 }));
    expect(mocks.discoverIntegrationTargets).toHaveBeenLastCalledWith("workspace-a", {
      provider: "gitlab", config: { connectionId: "connection-a", search: "Rare" },
    }, expect.any(AbortSignal));
    expect(screen.getByText("2 targets selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect sources" }));
    await waitFor(() => expect(mocks.createIntegration).toHaveBeenCalledOnce());
    expect(mocks.createIntegration.mock.calls[0]).toEqual(["workspace-a", expect.objectContaining({
      config: { connectionId: "connection-a", targets: [
        { kind: "group", identifier: "7", legacyExternalIds: false },
        { kind: "project", identifier: "999", legacyExternalIds: false },
      ] },
    })]);
  });

  it("requires a shared GitLab connection before connecting a project", async () => {
    mocks.gitlabConnections.mockResolvedValue([]);
    renderSettings();
    await screen.findByText(/Add a GitLab connection in Settings/);
    expect(screen.getByRole("button", { name: /^GitLab/ })).toBeDisabled();
    expect(mocks.discoverIntegrationTargets).not.toHaveBeenCalled();
  });

  it("configures GitLab globally without an open project or fetching targets", async () => {
    mocks.appState.selectedProjectId = undefined;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><GitlabConnectionsSettings /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add GitLab connection" }));
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(mocks.createGitlabConnection).toHaveBeenCalledWith({ name: "GitLab", baseUrl: "https://gitlab.com", token: "new-token" }));
    expect(mocks.discoverIntegrationTargets).not.toHaveBeenCalled();
    expect(mocks.createIntegration).not.toHaveBeenCalled();
  });

  it("groups Huly projects, validates manual rows, and saves every selection", async () => {
    mocks.discoverIntegrationTargets.mockResolvedValue({
      targets: [
        { kind: "project", identifier: "BOOST", name: "Boosted", workspace: "acme", workspaceName: "Acme workspace" },
        { kind: "project", identifier: "OPS", name: "Operations", workspace: "acme", workspaceName: "Acme workspace" },
      ],
    });
    let resolveCreate!: (value: Record<string, never>) => void;
    mocks.createIntegration.mockImplementationOnce(() => new Promise<Record<string, never>>((resolve) => {
      resolveCreate = resolve;
    }));

    renderSettings();
    await screen.findByText("No integrations installed");
    fireEvent.click(screen.getByRole("button", { name: /^Huly/ }));
    fireEvent.change(screen.getByLabelText("Connector endpoint"), { target: { value: "https://huly.example/issues" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "huly-user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "huly-password" } });

    expect(await screen.findByText("Acme workspace", {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(mocks.discoverIntegrationTargets).toHaveBeenLastCalledWith("workspace-a", {
      provider: "huly",
      config: {
        endpoint: "https://huly.example/issues",
        username: "huly-user",
        password: "huly-password",
      },
    }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("checkbox", { name: /Boosted/ }));
    fireEvent.click(screen.getByText("Advanced manual entry"));
    fireEvent.click(screen.getByRole("button", { name: "Add Huly project" }));
    fireEvent.change(screen.getAllByPlaceholderText("acme").at(-1)!, { target: { value: "other-workspace" } });
    expect(screen.getByText(/Complete or remove each manual Huly/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect sources" })).toBeDisabled();

    fireEvent.change(screen.getAllByPlaceholderText("BOOST").at(-1)!, { target: { value: "OTHER" } });
    const install = screen.getByRole("button", { name: "Connect sources" });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);

    await waitFor(() => expect(mocks.createIntegration).toHaveBeenCalledTimes(1));
    expect(mocks.createIntegration.mock.calls[0][1].config).toMatchObject({
      endpoint: "https://huly.example/issues",
      username: "huly-user",
      password: "huly-password",
    });
    expect(mocks.createIntegration.mock.calls[0][1].config).not.toHaveProperty("token");
    expect(mocks.createIntegration.mock.calls[0][1].config.targets).toEqual([
      { workspace: "acme", project: "BOOST", legacyExternalIds: false },
      { workspace: "other-workspace", project: "OTHER", legacyExternalIds: false },
    ]);
    expect(screen.getByRole("button", { name: /^GitLab/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Huly/ })).toBeDisabled();
    resolveCreate({});
    await waitFor(() => expect(screen.queryByText("Connect Huly")).not.toBeInTheDocument());
  });
});

describe("application updates", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appState.user.role = "admin";
    mocks.updateState.phase = "idle";
    mocks.updateState.supported = true;
    mocks.updateState.supportReason = undefined;
    mocks.refreshWebApp.mockReset().mockResolvedValue(undefined);
    mocks.isTauriRuntime.mockReturnValue(false);
  });

  it("uses one action for the app, backend, and web UI", () => {
    render(<ApplicationSettings />);
    expect(mocks.refreshAppUpdateAvailability).toHaveBeenCalledOnce();
    expect(screen.getByText(/One update for the selected machine/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update Boosted" }));
    expect(mocks.checkAndInstallAppUpdate).toHaveBeenCalledOnce();
    expect(screen.queryByText("Release security")).not.toBeInTheDocument();
  });

  it("restricts updates to administrators", () => {
    mocks.appState.user.role = "member";
    render(<ApplicationSettings />);
    const button = screen.getByRole("button", { name: "Update Boosted" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.checkAndInstallAppUpdate).not.toHaveBeenCalled();
  });

  it("prevents repeat clicks during updates", () => {
    mocks.updateState.phase = "restarting";
    render(<ApplicationSettings />);
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Restarting Boosted…");
    expect(screen.getByRole("button", { name: "Force update UI" })).toBeDisabled();
  });

  it("explains manual installations and disables their update action", () => {
    mocks.updateState.phase = "unsupported";
    mocks.updateState.supported = false;
    mocks.updateState.supportReason = "Development build";
    render(<ApplicationSettings />);
    expect(screen.getByText("Development build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Boosted" })).toBeDisabled();
  });

  it("lets members refresh the PWA UI even when server updates are unsupported", async () => {
    mocks.appState.user.role = "member";
    mocks.updateState.phase = "unsupported";
    mocks.updateState.supported = false;
    render(<ApplicationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Force update UI" }));
    await waitFor(() => expect(mocks.refreshWebApp).toHaveBeenCalledOnce());
    expect(mocks.refreshWebApp).toHaveBeenCalledWith();
    expect(mocks.checkAndInstallAppUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Force update UI" })).toBeEnabled());
  });

  it("prevents duplicate UI refreshes and server updates while refreshing", async () => {
    let finish!: () => void;
    mocks.refreshWebApp.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ApplicationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Force update UI" }));
    const button = screen.getByRole("button", { name: "Refreshing UI…" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update Boosted" })).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.refreshWebApp).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Force update UI" })).toBeEnabled());
  });

  it("shows UI update failures and lets the user retry", async () => {
    mocks.refreshWebApp.mockRejectedValueOnce(new Error("The web app update did not finish. Try again."));
    render(<ApplicationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Force update UI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The web app update did not finish. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Force update UI" }));
    await waitFor(() => expect(mocks.refreshWebApp).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Force update UI" })).toBeEnabled());
  });

  it("does not offer a PWA refresh in the desktop shell", () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    render(<ApplicationSettings />);
    expect(screen.queryByRole("button", { name: "Force update UI" })).not.toBeInTheDocument();
  });
});
