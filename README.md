# dsh-session-rollover

English | [简体中文](README.zh.md)

> Automatic session handoff for DeepSeek Harness, and task checkpoint handoff for TRAE, WorkBuddy and other MCP agents.

Fresh-session task handoff for DeepSeek Harness `0.2.0-rc.1`, `0.2.0-rc.2`, and `0.2.1-alpha.2`. It creates a new session before context pressure exhausts the model window, stores a task checkpoint as Markdown and JSON, and queues continuation on the new agent. The existing workspace remains the source of truth.

This is an independent community plugin, not an official DeepSeek component. Version `0.2.0` adds an independent local MCP stdio entrypoint for TRAE, WorkBuddy and other MCP agents, without installing a DSH host. DSH automatic handoff still requires accurate context-window metadata. GLM-5.1's 200K window is only the DSH default configuration example; other models should use adapter-reported capacity or an explicit fallback window.

| Integration | Task save/load | Automatic context measurement | Fresh-session creation and continuation |
| --- | --- | --- | --- |
| DeepSeek Harness plugin | Supported | Supported | Automatic, within host API limits |
| TRAE / WorkBuddy MCP | Supported, including handoff between clients | No common host interface | User or host creates the session, then loads the task |
| Other local MCP clients | Same three tools | No common host interface | Controlled by the client |

Configuration follows the [TRAE MCP documentation](https://docs.trae.cn/ide_add-mcp-servers) and [WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide). Tests cover independent client processes and legacy/modern MCP handshakes; they do not constitute individual client UI tests.

## TRAE, WorkBuddy and other MCP agents

The MCP entrypoint requires Node.js 20 or newer. To build from source, use the DSH development Node.js version below, run `pnpm install --frozen-lockfile`, then `pnpm run build`. The standalone entrypoint is `dist/mcp/cli.js`. A packed `.tgz` can be installed in an independent directory; the MCP binary does not load DSH, and its DSH peers are optional.

Copy the [TRAE configuration](examples/trae.mcp.json) or [WorkBuddy configuration](examples/workbuddy.mcp.json). Replace the script path and project path. An explicit `--workspace` is mandatory; configure the same workspace in both clients to share saved tasks.

```json
{
  "mcpServers": {
    "session-rollover": {
      "command": "node",
      "args": ["C:/path/to/dsh-session-rollover/dist/mcp/cli.js", "--workspace", "C:/path/to/your-project"]
    }
  }
}
```

- **TRAE**: paste the configuration under Settings → MCP → Add → Manual, or enable project MCP and merge it into `.trae/mcp.json`. Enable the server for the Agent you use. TRAE supports `${workspaceFolder}` for the project path.
- **WorkBuddy**: open Plugins → MCP Servers → Configure MCP and merge the configuration. Project configuration is `.workbuddy/mcp.json`; user configuration is `~/.workbuddy/mcp.json`. Allow custom MCP and these tools in the client's security settings. See also the [official stdio connector configuration](https://open.workbuddy.cn/en/docs/connector).
- **Other clients**: select local stdio MCP with the same executable and arguments; use the client's documented configuration location.

If Node is not on the client's PATH, use its absolute executable path as `command`. Keep paths containing spaces as individual `args`; do not put an entire shell command into `command`. Preserve existing MCP entries when adding this server.

Add [AGENT_RULES.md](docs/AGENT_RULES.md) to the client's Agent instructions or project rules so it saves at milestones and before session changes. These instructions cannot guarantee interception of automatic compaction. You can also ask the Agent to save a task checkpoint, then ask a new session to resume the returned task ID after checking the live workspace.

### Tools

| Tool | Purpose |
| --- | --- |
| `rollover_save` | Save a complete snapshot; returns task ID, checkpoint ID and next action. Reuse task ID on subsequent saves. |
| `rollover_list` | List the latest snapshot for each task, including completed tasks. |
| `rollover_load` | Load by task ID; optionally choose an earlier checkpoint ID. Returns checkpoint text and handoff instructions. |

Example first save:

```json
{
  "originalGoal": "Fix login while preserving the API",
  "currentGoal": "Verify the login fix",
  "currentWork": "Login code updated; tests not yet run",
  "nextAction": "Run the existing login tests",
  "requirements": ["Preserve the API"],
  "completed": ["Updated login code"],
  "pending": ["Run tests"]
}
```

Every save is a complete snapshot; omitted lists are empty. Keep `originalGoal` unchanged and record later clarifications in `requirements` and `currentGoal`. Status defaults to `in-progress`; save `completed` when finished. Required text fields allow 12,000 characters each; each list permits 12 entries of up to 2,000 characters. Record only facts needed for continuation.

Snapshots live in `<workspace>/.session-rollover/<taskId>.<checkpointId>.json/md`. JSON preserves full facts; Markdown clips long content and points to the JSON file. Each save creates independent files, committing with an atomic JSON rename. Concurrent snapshots both survive; the default latest snapshot sorts by timestamp and ID without merging competing states. Corrupt snapshots produce an error: back up and repair or move the reported file rather than overwriting it as an empty task.

Ignore `.session-rollover/` in your project's Git configuration. Checkpoints are plaintext local files; omit secrets. The server makes no network requests itself, but the client may send loaded content to its model. Use trusted local workspaces; directory validation does not replace OS permissions or a sandbox. This server collects Git status without modifying source files. It cannot capture private chat databases, running processes, host permissions or UI state. MCP storage is separate from DSH storage; it does not import DSH session transactions.

## Features

- Checks token pressure before each agent request and hands off before the configured hard limit.
- Writes durable Markdown and JSON checkpoints and resumes in a fresh session without copying old chat history.
- Preserves the original project, current working directory, selected model, and named permission preset where the host API supports them.
- Recovers interrupted rollover transactions after restart and cooperates with official compaction.
- Falls back to a deterministic checkpoint if optional LLM refinement fails.

## Why

Normal compaction reduces old conversation history inside the same session. A long coding task can still accumulate repeated compactions, large tool results, or overflow. This plugin adds a distinct session boundary while preserving a durable chain.

## Architecture and flow

`ContextMonitor → RolloverPolicy → CheckpointGenerator → CheckpointStore → SessionRolloverManager → FreshSessionCreator → CheckpointInjector → AutoResumeManager`

At `agent/pre-step`, the official token meter measures the durable request surface. The plugin adds newly claimed messages and applies soft and hard thresholds. The hard limit is `min(floor(window × hardRatio), window − outputReserve − safetyReserve)`. At the hard limit, the old request is rejected. A per-session lock admits one transaction. A deterministic checkpoint is written first; optional LLM refinement follows. After atomic file writes, Web uses its public `sessionController.create()` path, which internally composes the preset and calls `ctx.agents.create()`. Other runtimes use `ctx.agents.create()` directly. Neither path seeds old history. The new agent receives the checkpoint via `inject()` and continuation via `followup()`. Transferred user input starts continuation without an extra synthetic turn. `agent/request-error` triggers emergency handoff on context overflow; a successful handoff stops retries in the retired session. The official compaction plugin remains in place.

Transaction states are `NORMAL`, `ARMED`, `CHECKPOINTING`, `ROLLOVER_PENDING`, `CREATING_SESSION`, `RESUMING`, `COMPLETED`, `FAILED`, and `EMERGENCY_ROLLOVER`. A saved transaction ID and preselected target session ID make restart recovery reuse the same identity.

## DSH installation

Requires Node.js `^22.19.0 || >=24.0.0`, pnpm, and a DSH `0.2.0-rc.1`, `0.2.0-rc.2`, or `0.2.1-alpha.2` runtime. Clone the repository, then run:

```powershell
git clone https://github.com/terryvanke/dsh-session-rollover.git
cd dsh-session-rollover
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add .
```

If `dsh` is not on `PATH`, run the installed `@deepseek-ai/dsh` package's `lib/bin.js` with Node.js in place of `dsh`. The package declares `dsh.bundle`, so the profile adds its patch layer automatically. Inspect the effective configuration with `dsh --profile web --dump-config`. The installed Web profile must already be valid; fix unrelated invalid patch rows before booting. See the [official bundle installation guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) for profile details.

## Configuration

The bundle enables the plugin with defaults. Override its row in the profile's `cordis.patch.yml` using the full `config` object; DSH patch replacement is not a deep merge.

| Field | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Enable listener registration |
| `context.windowTokens` | `200000` | Fallback when adapter omits context capacity |
| `context.softThresholdRatio` | `0.65` | Arm rollover |
| `context.hardThresholdRatio` | `0.72` | Block old-session requests |
| `context.reserveOutputTokens` | `32000` | Fallback output reserve |
| `context.safetyTokens` | `24000` | Checkpoint and provider headroom |
| `checkpoint.maxTokens` | `8192` | LLM checkpoint output cap |
| `checkpoint.includeRecentMessages` | `12` | Deterministic recent user messages; `0` omits them |
| `checkpoint.includeToolResults` | `8` | Deterministic recent tool results; `0` omits them |
| `checkpoint.retries` | `3` | LLM checkpoint retries |
| `rollover.maxRollovers` | `100` | Chain cap |
| `rollover.minIntervalSeconds` | `60` | Soft-rollover spacing; hard/overflow override it |
| `rolloverAfterCompactions` | `0` | Optional soft-threshold compaction count |
| `storage.directory` | `.dsh/rollover` | Relative to session workspace |

Other fields are defined in `src/config.ts`: file and git inclusion, auto resume, workspace/model/preset metadata preservation, deterministic and overflow fallbacks, and notification logging.

### GLM 200K recommendation

Keep the defaults for a 200,000-token route. The hard limit is 144,000 tokens with 32,000 reserved output tokens and 24,000 safety tokens. If your adapter advertises a different model context window or output cap, its metadata takes precedence. Set the GLM adapter's `contextWindow` to its actual capacity when available.

## Checkpoints and crash recovery

Each workspace writes `.dsh/rollover/<chain-id>/chain.json`, plus `session-001.md` and `session-001.json`, etc. JSON stores lineage, original/current task, workspace state, files, progress, errors, decisions, the next action, and route metadata. Markdown is the model-facing handoff. Files are written to a temporary file, synced, and renamed. On restart, incomplete chain transactions are inspected; the stored target ID is resumed if persisted or created once if absent. The new agent is told to verify `git status`, `git diff --stat`, and referenced files before editing.

On `0.2.1-alpha.2`, checkpoints capture the effective directory through the optional `workingDirectory` service. The new session retains the original project in its header and restores named permissions before setting its current directory. Checkpoint storage stays under the original project so restart recovery can find it. Earlier checkpoints without `originalCwd` remain readable.

## Compaction compatibility

Keep `@deepseek-ai/dsh-compaction-basic` mounted in the Agent preset. It runs at `agent/pre-step`, uses `ctx.tokenMeter`, and defaults to a 0.8 ratio capped by the model window minus routed output tokens and its 65,536-token headroom. On a 200K route this cap can make compaction run before rollover. The backend has its own bounded context-overflow recovery. This plugin observes completed compaction events for optional soft rollover; its hard safety threshold always wins.

## Limitations

- The plugin records a structured rollover notice in the host log and does not switch the browser tab automatically.
- In Web, the public session controller composes the preset and model selection, and the permission preset service restores a named permission preset. Arbitrary custom Agent setup callbacks cannot be cloned; a `custom` permission state fails closed. An in-flight one-shot subagent run cannot be reattached to its parent tool result through the public Agent API; the plugin skips that session type and leaves official compaction in control. Such deployments need a dedicated subagent integration before unattended rollover.
- The deterministic fallback reads recent events through `Session.snapshotEvents()`, which this DSH version marks deprecated. Migration to `session-query` is planned.
- Restart recovery guarantees a stable target session ID. A crash after enqueueing continuation but before recording completion can re-enqueue the continuation. The filesystem check reduces duplicate work, but an exactly-once continuation queue requires a host-level transaction API.
- E2E coverage includes the real Cordis runtime, Agent loop, Session store, and token meter with a scripted local model adapter, plus a simulated multi-session chain. It does not call a live GLM model.

Development dependencies and the lockfile target `0.2.1-alpha.2`. Compatibility checks also cover `0.2.0-rc.1` and `0.2.0-rc.2`; alpha releases remain upstream preview builds.

## Troubleshooting

If boot fails with `patch: entry ... not found`, inspect the Web profile's own `cordis.patch.yml` for an old row ID. If a plugin does not activate, verify `dsh.bundle` appears in `package.json`, then inspect `dsh --profile web --dump-config`. If a model has no declared context capacity, set `context.windowTokens` to the verified value. A failed session creation leaves the old agent intact and writes `FAILED` to the chain.

## Development and testing

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:e2e
pnpm run build
```

## V2

Add host-supported session-chain UI and automatic focus, integrate preset setup composition, move fallback reads to the public query service, and add an exactly-once continuation marker if DSH exposes a transaction seam.

## Contributing and license

Issues and pull requests are welcome. Run the checks in **Development and testing** before submitting a change. Released under the [MIT License](LICENSE).
