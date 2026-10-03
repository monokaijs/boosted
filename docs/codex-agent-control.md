# Codex chat controls

Agent tools use the real `codex app-server --stdio` subprocess and the
[Codex App Server protocol](https://learn.chatgpt.com/docs/app-server).
Provider accounts resolve their configured `settings.codexHome`, or their
isolated account directory, before starting the process. The child receives
that path as `CODEX_HOME`; inherited OpenAI credentials are removed. A process
is shared by chats belonging to that account. Stopping one chat does not kill
the process or other chats.

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
```

That integration uses a temporary account home and a loopback Responses
endpoint. It verifies exact model requests, completed and interrupted turns,
forks, clearing and deletion without external inference or existing chats.
