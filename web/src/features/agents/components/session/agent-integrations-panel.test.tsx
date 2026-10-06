import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentIntegration } from "@/features/agents/types/assistant"

const mocks = vi.hoisted(() => ({
  state: { user: { id: "admin", role: "admin" } as { id: string; role: string } },
  integrations: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  testIntegration: vi.fn(),
  setIntegrationChatApproval: vi.fn(),
}))

vi.mock("@/lib/store", () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }))
vi.mock("@/features/agents/lib/api-client", () => ({ apiClient: { assistant: {
  integrations: mocks.integrations,
  createIntegration: mocks.createIntegration,
  updateIntegration: mocks.updateIntegration,
  deleteIntegration: mocks.deleteIntegration,
  testIntegration: mocks.testIntegration,
  setIntegrationChatApproval: mocks.setIntegrationChatApproval,
} } }))

import { AgentIntegrationsPanel } from "./agent-integrations-panel"

const connection: AgentIntegration = {
  id: "slack-a",
  agentId: "agent-a",
  provider: "slack",
  name: "Team Slack",
  enabled: true,
  bot: { id: "bot-a", name: "Boosted Agent" },
  workspace: "Acme",
  status: "connected",
  hasBotToken: true,
  hasAppToken: true,
  slackManifest: "socket_mode_enabled: true",
  chats: [
    { id: "pending-a", integrationId: "slack-a", externalId: "C123", name: "engineering", kind: "channel", status: "pending", lastSeenAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
    { id: "approved-a", integrationId: "slack-a", externalId: "D123", name: "Direct message", kind: "dm", status: "approved", approvedAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
  ],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><AgentIntegrationsPanel agentId="agent-a" agentName="Pock" /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.user = { id: "admin", role: "admin" }
  mocks.integrations.mockResolvedValue([connection])
  mocks.updateIntegration.mockResolvedValue(connection)
  mocks.setIntegrationChatApproval.mockResolvedValue(connection.chats[0])
})
afterEach(cleanup)

describe("agent integrations", () => {
  it("warns administrators and manages approvals without displaying credentials", async () => {
    renderPanel()
    expect(screen.getByText(/Every member of an approved chat/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: /Team Slack/ }))
    expect(screen.getByText("Direct message")).toBeInTheDocument()
    expect(screen.queryByText(/xoxb-/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Approve engineering" }))
    await waitFor(() => expect(mocks.setIntegrationChatApproval).toHaveBeenCalledWith("agent-a", "slack-a", "pending-a", true))
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    await waitFor(() => expect(mocks.updateIntegration).toHaveBeenCalledWith("agent-a", "slack-a", { reconnect: true }))
  })

  it("gives members sanitized read-only status", async () => {
    mocks.state.user = { id: "member", role: "member" }
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: /Team Slack/ }))
    expect(screen.getByText("Direct message")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve engineering" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Slack" })).not.toBeInTheDocument()
  })
})
