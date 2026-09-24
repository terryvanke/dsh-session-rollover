# dsh-session-rollover

English | [简体中文](README.zh.md)

> Automatic session handoff for long-running DeepSeek Harness agents.

Fresh-session task handoff for DeepSeek Harness `0.1.7-rc.1`. It creates a new session before context pressure exhausts the model window, stores a task checkpoint as Markdown and JSON, and queues continuation on the new agent. The existing workspace remains the source of truth.

This is an independent community plugin, not an official DeepSeek component. It works with models routed through DSH when the provider exposes a usable context window. GLM-5.1 with a 200K window is the default scenario; other model routes should report their actual window or set the fallback capacity explicitly. It is not a universal adapter for models outside DSH.

## Features

- Checks token pressure before each agent request and hands off before the configured hard limit.
- Writes durable Markdown and JSON checkpoints and resumes in a fresh session without copying old chat history.
- Preserves the workspace, selected model, and named permission preset where the host API supports them.
- Recovers interrupted rollover transactions after restart and cooperates with official compaction.
- Falls back to a deterministic checkpoint if optional LLM refinement fails.

## Why

Normal compaction reduces old conversation history inside the same session. A long coding task can still accumulate repeated compactions, large tool results, or overflow. This plugin adds a distinct session boundary while preserving a durable chain.

## Architecture and flow

`ContextMonitor → RolloverPolicy → CheckpointGenerator → CheckpointStore → SessionRolloverManager → FreshSessionCreator → CheckpointInjector → AutoResumeManager`

At `agent/pre-step`, the official token meter measures the durable request surface. The plugin adds newly claimed messages and applies soft and hard thresholds. The hard limit is `min(floor(window × hardRatio), window − outputReserve − safetyReserve)`. At the hard limit, the old request is rejected. A per-session lock admits one transaction. A deterministic checkpoint is written first; optional LLM refinement follows. After atomic file writes, Web uses its public `sessionController.create()` path, which internally composes the preset and calls `ctx.agents.create()`. Other runtimes use `ctx.agents.create()` directly. Neither path seeds old history. The new agent receives the checkpoint via `inject()` and continuation via `followup()`. `agent/request-error` triggers emergency handoff on context overflow. The official compaction plugin remains in place.

Transaction states are `NORMAL`, `ARMED`, `CHECKPOINTING`, `ROLLOVER_PENDING`, `CREATING_SESSION`, `RESUMING`, `COMPLETED`, `FAILED`, and `EMERGENCY_ROLLOVER`. A saved transaction ID and preselected target session ID make restart recovery reuse the same identity.

## Installation

Requires Node.js, pnpm, and a DSH `0.1.7-rc.1` runtime. Clone the repository, then run:

```powershell
git clone https://github.com/terryvanke/dsh-session-rollover.git
cd dsh-session-rollover
pnpm install
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
| `checkpoint.includeRecentMessages` | `12` | Deterministic recent user messages |
| `checkpoint.includeToolResults` | `8` | Deterministic recent tool results |
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

## Compaction compatibility

Keep `@deepseek-ai/dsh-compaction-basic` mounted in the Agent preset. It runs at `agent/pre-step`, uses `ctx.tokenMeter`, and defaults to a 0.8 ratio capped by the model window minus routed output tokens and its 65,536-token headroom. On a 200K route this cap can make compaction run before rollover. The backend has its own bounded context-overflow recovery. This plugin observes completed compaction events for optional soft rollover; its hard safety threshold always wins.

## Limitations

- The public DSH `0.1.7-rc.1` API has no stable Web focus or user-toast API; V1 records a structured rollover notice in the host log and does not switch the browser tab automatically.
- In Web, the public session controller composes the preset and model selection, and the permission preset service restores a named permission preset. Arbitrary custom Agent setup callbacks cannot be cloned; a `custom` permission state fails closed. An in-flight one-shot subagent run cannot be reattached to its parent tool result through the public Agent API; the plugin skips that session type and leaves official compaction in control. Such deployments need a dedicated subagent integration before unattended rollover.
- The deterministic fallback reads recent events through `Session.snapshotEvents()`, which this DSH version marks deprecated. Migration to `session-query` is planned.
- Restart recovery guarantees a stable target session ID. A crash after enqueueing continuation but before recording completion can re-enqueue the continuation. The filesystem check reduces duplicate work, but an exactly-once continuation queue requires a host-level transaction API.
- The included E2E test uses a fake Agent and token pressure. It does not call a live GLM model.

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
