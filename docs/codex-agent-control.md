# Codex chat controls

Agent tools use the real `codex app-server --stdio` subprocess and the
[Codex App Server protocol](https://learn.chatgpt.com/docs/app-server).
Provider accounts resolve their configured `settings.codexHome`, or their
isolated account directory, before starting the process. The child receives
that path as `CODEX_HOME`; inherited OpenAI credentials are removed. A process
is shared by chats belonging to that account. Stopping one chat does not kill
the process or other chats.

The persistent assistant uses a separate ephemeral app-server thread for each
turn, with read-only native shell/file access
for management and independent review, and no execution approvals. Project
work is dispatched to persistent Codex coding chats with watched runs. The
manager inspects each outcome and sends follow-up instructions in the same
chat when authorized work or verification remains incomplete. Verified results
are reported for human curation; later feedback continues the same chat. MCP
configuration is inherited from the selected account's Codex home. Boosted's dynamic management tools remain
available alongside native inspection tools. Chat metadata stores the managing
agent, original request and feedback message IDs, and latest dispatched run.
Each continuation carries those source messages into its watch and recovery
record, so background turns retain the goal. The model receives durable managed
chat references and saved follow-ups in addition to conversation history.
Commands, file changes, web searches,
image views and MCP calls are saved as action receipts, including failures.
In group conversation, the leader can quietly forward a current human message
to its intended participant with `forward_group_message`. The delivery preserves
the original message, sender and attachments without posting a leader bubble.
A successful forward ends the leader's turn; the recipient replies directly to
the human. Only the current leader may forward a delivered human message, and
recipients must belong to the group. Repeated forwarding does not duplicate a
delivery. Conversational nicknames remain aliases in the available chat context;
they do not change saved profiles unless the human requests a saved name change.
Stopping or timing out an assistant turn interrupts Codex and cleans its
background terminals before shutting down its dedicated subprocess. Normal
completion also cleans background terminals. Interrupted actions with no
saved result are marked `resultUnknown`; recovery must inspect live state
before retrying a mutation.

Persistent agents also receive the bundled
[computer-control skill](../server/skills/computer-control/SKILL.md), with
`computer_status`, `computer_screenshot`, and `computer_action` dynamic tools.
These use XCap and Enigo in the Rust server process to control its host desktop.
Screenshots are bounded to 1600 pixels on the longest edge and delivered as
Codex `inputImage` content; only metadata is saved in action receipts. Input
coordinates are mapped from the screenshot to the selected display's native
coordinate system, including Retina scaling and secondary displays.

Each screenshot belongs to its agent, expires after 60 seconds, and is consumed
by one input action. Any input invalidates other agents' snapshots. A shared
desktop mutex serializes capture and input, and display-layout changes reject
old coordinates. Independent human input is not detected; agents must refresh
screenshots when focus may have changed. Dropping a tool future on Stop or
timeout cancels queued work and multi-step input between events, releases held
keys and drag buttons, and retains the lock until the worker exits. Delivered
events cannot be rolled back. End-of-turn cleanup discards that agent's screen
token. OS screen/input permissions and an interactive desktop are required;
Linux input supports X11, not Wayland. No desktop sidecar or Docker service is
needed. This adapts the screenshot/input workflow from
[OpenDots](https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md)
to Boosted's existing host-access policy.

| Tool | Behavior |
| --- | --- |
| `list_models` | Read the selected account's model catalog and reasoning efforts. Catalog membership is not an inference entitlement check. |
| `create_chat` | Validate the project, title, prompt and selected model before creating a thread. Start a real turn by default, with full access and no approvals. Explicit `startRun: false` creates an empty, idle chat. |
| `set_chat_model` | Save an exact catalog model and supported reasoning effort for the next run of an idle chat. Preserve access and history. |
| `set_chat_access` | Set full, workspace or read-only access and an approval policy for an idle chat's next run. |
| `send_message` | Start a turn, queue instructions for an active turn, or steer it. Explicitly sending work resumes a stopped chat. |
| `read_run` | Inspect an exact run's queued, active or terminal status. |
| `stop_run` | Interrupt the specified active turn or cancel the specified queue entry. A stale run ID cannot interrupt newer work. |
| `stop_chat` | Pause automatic dispatch and quota recovery, cancel queued work, pause an active Codex goal, interrupt the current turn and clean its background terminals. Works while idle too. |
| `fork_chat` | Copy history into a distinct thread on the same account. Preserve current runtime settings; optionally set a model/title, fork through a turn, or dispatch a prompt. Defer automatic goal continuation. |
| `clear_chat` | Create an empty replacement with the same account, title, model and access. Archive the original and cancel its queued work and follow-ups. Return both IDs; subsequent work uses the new ID. Archived history remains available to forks. |
| `delete_chat` | Permanently delete the conversation using Codex, then clean local metadata, queued work, approvals and follow-ups. Record a tombstone to prevent copied history resurfacing. |

Creation and dispatch are separate operations. If dispatch fails after thread
creation, the tool fails and includes the created chat ID so the agent can retry
`send_message` without duplicating the conversation. `INTERRUPTING` means the
cancellation request was accepted; `read_run` verifies the terminal result.

The installed CLI (0.159.3) rejects deletion of a source conversation while
independent forks still reference its history. A rejected deletion preserves
local records and reports the restriction. Delete dependent forks only when
the user requests their deletion. Clearing uses an empty replacement and
archives the original because the current CLI has no history-reset RPC.

Queue dispatch, model changes, stopping and conversation mutations share a
per-chat lock. The scheduler rechecks queue entries after acquiring that lock,
so entries cancelled by a stop cannot restart from an earlier snapshot.

Run the synthetic subprocess regressions with:

```sh
cargo test -p boosted-server --lib agents::tests::coding_
```

Run the installed CLI integration explicitly with:

```sh
cargo test -p boosted-server --lib agents::tests::installed_codex_executes_and_interrupts_through_agent_tools -- --ignored
cargo test -p boosted-server --lib agents::tests::installed_codex_manager_inspects_without_modifying_project -- --ignored
cargo test -p boosted-server --lib agents::tests::installed_codex_agent_delivers_computer_screenshot_as_visual_input -- --ignored
```

That integration uses a temporary account home and a loopback Responses
endpoint. It verifies exact model requests, completed and interrupted turns,
forks, clearing and deletion without external inference or existing chats.
The manager integration uses a loopback model endpoint to verify read-only
inspection, denial of project file writes, and application tool replies. The
synthetic manager regression covers dispatch, watched outcomes, automatic
continuation, human curation, and persisted request context after reload.

The screenshot integration uses a fake desktop and verifies that the installed
CLI forwards image content to a loopback model endpoint, including code mode.
Run desktop policy tests with `cargo test -p boosted-server --lib computer::tests`.
For a read-only live capture check after granting OS permissions, run
`cargo test -p boosted-server --lib computer::tests::native_desktop_status_and_screenshot -- --ignored --nocapture`.
