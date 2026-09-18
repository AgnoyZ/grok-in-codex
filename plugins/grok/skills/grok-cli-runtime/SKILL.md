---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Codex
user-invocable: false
---

# Grok Runtime

Use through the Grok MCP tools. If MCP is unavailable, call the companion directly with `node plugins/grok/scripts/grok-companion.mjs <command> ...`.

Recommended Grok CLI version: **≥ 0.2.118**.

## Workspace

Installed Codex plugin MCP servers start from the plugin cache. Pass `cwd` with the active project
directory on every Grok MCP call so Grok inspects, edits, and stores artifacts in the intended
workspace rather than the cached plugin directory. Direct companion calls can use `--cwd <path>`.

## Concurrency

- **Multiple companion jobs may run at once.** There is no global single-agent lock.
- Prefer `background: true` or `--background` when a Codex turn is launching more than one Grok job.
- Each MCP call should make exactly one companion invocation.
- Parallelism = multiple background companion jobs, not a serialized queue.
- When several jobs are running, always pass job ids to `status` / `result` / `cancel`.

## Control flags (most write/plan commands)

MCP input keys map to companion flags:

| MCP property | Companion flag |
| --- | --- |
| `sandbox` | `--sandbox` |
| `planMode` | `--plan` |
| `permissionMode` | `--permission-mode` |
| `agent` | `--agent` |
| `noSubagents` | `--no-subagents` |
| `memory` / `noMemory` | `--memory` / `--no-memory` |
| `allow` / `deny` | `--allow` / `--deny` (repeatable) |
| `disableWebSearch` | `--disable-web-search` |
| `forkSession` | `--fork-session` |
| `maxTurns` | `--max-turns` |

## CLI posture

- Prefer **denylist** (`--disallowed-tools`) over tools allowlist (Grok session-create bugs).
- Media: no yolo / no tools allowlist.
- `--dry-run` / `--validate-only` / babysit `list`: **read-only** (no yolo).
- Write-capable default for rescue/design/execute/babysit add|check|remove.

## Depth notes

- `grok_execute_plan` with `latest=true` resolves newest `.grok-designs/*.md`.
- Design/workflow/plan/document jobs harvest copies into `.grok-designs/` / `.grok-workflows/` / `.grok-plans/` / `.grok-docs/`.
- Review `postPending=true`: skips empty findings; empty/oversize diffs fail closed and save findings under `.grok-reviews/`.
- Plan results prefer harvested `plan.md` body over narration.
- Stop-gate uses sandbox `read-only` + denylist (no yolo).

## State env

- Default job state: `~/.grok/codex-plugin/state/`
- Override: `GROK_CODEX_PLUGIN_STATE`
- Host plugin data: `CODEX_PLUGIN_DATA` only when the dir basename is trusted (`grok` / `grok-*`)
- Does **not** share Claude plugin state (`GROK_CLAUDE_PLUGIN_STATE` / `claude-plugin`)

## Task (`grok_rescue`)

- Exactly one `task` invocation per handoff
- `fast` uses the Grok CLI configured default model with `--effort low`
- `deep` uses the Grok CLI configured default model with `--effort high`
- `default` and `grok` use the Grok CLI configured default model without forcing an effort
- Only an explicit model id is forwarded with `--model`; never hard-code the configured model
- `resume` → `--resume-last`; `resumeSession` → resume that id; `fresh` → no resume
- Pass `worktree` and `bestOfN` through when present.
- `check=true` appends a verification contract to the prompt before the
  prompt file is written (Grok CLI 1.x has no `--check` flag). This is
  implementer evidence, not host final acceptance.
- Default write-capable; `readOnly` only when requested

## Implement (`grok_implement`)

- Exactly one `task --check` invocation per handoff
- Compose the implementer prompt from `implementationBrief` + `acceptanceCriteria`
  (optional `allowedFiles`, `forbiddenChanges`, `verificationCommands`)
- Default `--model deep` only when no `model` or `effort` is supplied; `deep`
  remains an effort preset and must not pin a model id
- Preserve explicit `model` / `effort` overrides
- `resume` / `resumeSession` correct the same session; `fresh` starts over
- `parallelWrite=true` requires a worktree or explicit `allowedFiles` ownership
- `correctionAttempt` requires resume semantics and is bounded by `maxCorrectionAttempts` (default 2)
- Host Codex remains planner and final verifier

## Plan (`grok_plan`)

- Forces plan permission mode; harvests `.grok-plans/`

## Review (`grok_review` / `grok_adversarial_review`)

- Read-only; never apply patches
- `postPending` + `pr` posts a GitHub PENDING review

## Workflow / design / execute / babysit / document / sessions

- `grok_workflow` — `action=list|run`; list and `validateOnly` are read-only
- `grok_design` — design-doc writer/reviewer loop
- `grok_execute_plan` — PR Plan DAG; `dryRun` is read-only
- `grok_babysit` — `action=add|list|check|remove`; list is read-only
- `grok_document` — `type=pptx|pdf|docx`
- `grok_sessions` — `action=list|search|export`

## Media (`grok_image` / `grok_video`)

- Artifacts under `.grok-media/image/` and `.grok-media/video/`

## Jobs

- `grok_status` / `grok_result` / `grok_cancel`
- Status shows accumulated stream progress (text + thought tails); whitespace-only stays `running`
- Result includes usage and artifacts when present
