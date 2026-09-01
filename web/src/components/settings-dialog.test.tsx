import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appState: { selectedProjectId: "workspace-a" as string | undefined },
  integrations: vi.fn(),
  discoverIntegrationTargets: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  syncIntegration: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/store", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.appState) => unknown) => selector(mocks.appState),
    { getState: () => mocks.appState },
  ),
}));

import { IntegrationsSettings } from "@/components/settings-dialog";

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

  it("auto-explores credentials and clears new selections when the connection changes", async () => {
    renderSettings();
    await screen.findByText("No integrations installed");
    fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "first-token" } });

    await waitFor(() => expect(mocks.discoverIntegrationTargets).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const group = await screen.findByRole("checkbox", { name: /Acme/ });
    fireEvent.click(group);
    expect(screen.getByText("1 target selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install plugin" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "second-token" } });

    await waitFor(() => expect(screen.getByText("0 targets selected")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Install plugin" })).toBeDisabled();
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
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "first-token" } });
    await waitFor(() => expect(mocks.discoverIntegrationTargets).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const firstSignal = mocks.discoverIntegrationTargets.mock.calls[0][2] as AbortSignal;

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "second-token" } });
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
        baseUrl: "https://gitlab.example",
        token: "gitlab-token",
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
    expect(screen.getByRole("button", { name: "Install plugin" })).toBeDisabled();

    fireEvent.change(screen.getAllByPlaceholderText("BOOST").at(-1)!, { target: { value: "OTHER" } });
    const install = screen.getByRole("button", { name: "Install plugin" });
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
    await waitFor(() => expect(screen.queryByText("Install Huly")).not.toBeInTheDocument());
  });
});
