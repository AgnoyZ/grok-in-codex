# Grok plugin for Codex

Use [Grok](https://grok.com) from inside Codex for code reviews, delegated coding, planning, multi-agent workflows, design→execute pipelines, PR babysitting, and image/video/document generation.

**Plugin version:** 0.8.0. Codex stays the orchestrator. A thin MCP server + companion script hands real work to Grok on your machine via the local CLI. Setup checks the historical **0.2.118** version floor and probes advertised CLI capabilities.

Default artifact dirs: `.grok/plans/`, `.grok/designs/`, `.grok/workflows/`, `.grok/docs/`, `.grok/reviews/`, `.grok/media/`. Setup adds these six subdirectories and the legacy `.grok-*/` pattern to the target Git repository's local `info/exclude`, without changing `.gitignore` or ignoring all of `.grok/`. Explicit output paths remain supported. Existing artifacts are not moved or deleted; `latest` selects from `.grok/designs/`, and old design documents can still be passed by explicit path.

Using Claude Code instead? Use the sibling plugin: [grok-in-claude](https://github.com/stdevMac/grok-in-claude).

## What you get

| Codex MCP tool | Purpose |
| --- | --- |
| `grok_setup` | Check CLI + auth + version floor + doctor; toggle stop review gate |
| `grok_rescue` | Delegate investigation / fixes (isolated worktree by default; full control flags) |
| `grok_implement` | Host-led implement: Codex plans/verifies, Grok implements a host-approved brief |
| `grok_plan` | Plan mode only (explore → plan.md under `.grok/plans/`) |
| `grok_review` | Structured read-only review (tree / branch / PR; optional `postPending`) |
| `grok_adversarial_review` | Challenge design, tradeoffs, and assumptions |
| `grok_workflow` | List/run Grok Rhai multi-agent workflows |
| `grok_design` | Design doc + PR plan (writer/reviewer loop → `.grok/designs/`) |
| `grok_execute_plan` | Execute a design-doc PR Plan DAG |
| `grok_babysit` | Watch PRs / fix CI & review comments (`list` is read-only) |
| `grok_document` | Generate docx / pdf / pptx → `.grok/docs/` |
| `grok_media` | `kind=image` or `kind=video` → `.grok/media/` |
| `grok_sessions` | List / search / export Grok sessions |
| `grok_transfer` | Build context-transfer guidance for Grok |
| `grok_job` | `action=status` (default), `result`, or `cancel`; cancellation requires `jobId` |
| `grok_artifacts` | Read-only artifact discovery or migration preview with path conflicts |

**Control flags** (rescue/implement/plan/review and long-running jobs): `sandbox`, `planMode` / `permissionMode`, `agent`, `noSubagents`, `memory` / `noMemory`, `allow` / `deny`, `disableWebSearch`, `forkSession`, `maxTurns`.

Skills: brand/media recipes, routing (host-led implement vs Grok-owned plan/design), runtime contracts, workflows, prompting, orchestrated coding.

### Breaking MCP change in 0.8.0

The five old MCP names are removed, with no aliases or compatibility layer:

| Removed tool | Replacement |
| --- | --- |
| `grok_status` | `grok_job action=status` |
| `grok_result` | `grok_job action=result` |
| `grok_cancel` | `grok_job action=cancel jobId="..."` |
| `grok_image` | `grok_media kind=image` |
| `grok_video` | `grok_media kind=video` |

The companion's underlying CLI commands and result formats are unchanged. `grok_job` accepts
`all` only for status and `maxChars` only for result. `grok_media` requires a kind; image editing
uses `edit`, while video uses `image`, `refs`, and `duration`. Inapplicable options return errors.
Update external MCP callers and start a new Codex task after installing this version.

## Requirements

- **Node.js 18.18 or later**
- **[Grok Build CLI](https://grok.com)** (`grok`) on your `PATH`
- **Grok authentication** (`grok login`)
- **GitHub CLI (`gh`)** only if you use `grok_review` with PRs or post-pending

Typical CLI location: `~/.grok/bin/grok` (ensure it is on `PATH`).

## Install

From GitHub:

```bash
codex plugin marketplace add AgnoyZ/grok-in-codex
codex plugin add grok@grok-in-codex
```

Then start a new Codex thread so the plugin skills and MCP tools are loaded.

### Install locally

```bash
codex plugin marketplace add /path/to/grok-in-codex/.agents/plugins
codex plugin add grok@grok-in-codex
```

Run setup:

```bash
node plugins/grok/scripts/grok-companion.mjs setup
```

Or ask Codex to call `grok_setup`.

## Quick start

```text
Ask Grok to review this branch against main.
Have Codex plan and Grok implement the retry jitter change.
Use Grok to plan the auth rewrite.
Generate a design doc with Grok, then execute the latest plan dry-run.
Start a background Grok rescue job for the retry redesign.
Generate a 16:9 launch banner with Grok.
Show Grok job status.
```

Direct MCP tool examples:

Include `cwd="/path/to/project"` on these calls when using an installed plugin.

```text
grok_plan prompt="plan the auth rewrite" background=true
grok_design prompt="design multi-tenant billing" background=true
grok_execute_plan latest=true dryRun=true
grok_workflow action=list
grok_review base=main focus="auth, data loss, and race conditions"
grok_rescue prompt="investigate why npm test is failing" background=true
grok_implement implementationBrief="Add full jitter to src/retry.ts per the host plan" acceptanceCriteria=["Retries use full jitter","Existing retry tests pass"] verificationCommands=["npm test"]
grok_babysit action=list
grok_document type=pdf prompt="one-pager for the launch"
grok_sessions action=list
grok_job action=status
grok_job action=result jobId="plan-abc123"
grok_media kind=image aspect="16:9" prompt="Dark developer-tool launch banner"
grok_media kind=video image="./.grok/media/image/hero.png" duration="6" prompt="gentle camera push-in"
```

### Workspace selection

Codex starts an installed plugin MCP server from the plugin cache, so pass the active project
directory as `cwd` when calling a Grok tool from an installed plugin. The companion then runs in
that directory and keeps jobs, git inspection, and artifacts scoped to the intended workspace.

Write tools reject a missing `cwd` if the MCP server starts inside the plugin installation.
Nonexistent paths and files are rejected before Grok launches. Read-only tools keep the existing
fallback to the server's working directory. MCP roots negotiation is not implemented.

For direct local calls, use for example:

```text
grok_review cwd="/path/to/project" base=main
grok_job action=status cwd="/path/to/project" json=true
```

## Host-led implementation

When Codex should plan and verify while Grok implements (including dual-model implementation briefs):

1. Codex reads the repo and captures baseline git/test status before any writes.
2. Codex writes a concrete `implementationBrief` and `acceptanceCriteria`. Optional: `allowedFiles`, `forbiddenChanges`, `verificationCommands`.
3. Call **`grok_implement`**. Do not edit the same workspace while Grok runs.
4. Codex independently inspects `git status` / `git diff` and re-runs the appropriate checks. Never trust Grok narration as final acceptance.
5. Corrections resume the same Grok session (`resumeSession` / `resume`).

Do **not** use `grok_plan` or `grok_design` for that host-owned planning phase. Those remain for **Grok-owned** planning.

`grok_implement` maps to companion `task --write --check`, preserving its direct-write default. It defaults `--model deep` only when no `model` or `effort` is supplied. `deep` is an effort preset over the Grok CLI configured model; it does not pin a model id. This tool does not certify host final acceptance.

## Depth pipeline

For multi-PR or ambiguous product work where **Grok** owns planning, prefer:

1. **`grok_plan`** — explore + harvest `plan.md`
2. **`grok_design`** — design doc + PR plan under `.grok/designs/`
3. **`grok_execute_plan`** with `latest=true` — implement the PR DAG
4. **`grok_review`** / **`grok_babysit`** — quality and CI loop

## Job control semantics

- **Workspace write locks** — one writer per canonical workspace, including media, documents, design and workflow execution. Other workspaces and read-only jobs can run concurrently. The conflict error names the owning job; finish or cancel it before retrying. Locks coordinate plugin jobs, not edits from your editor or other tools.
- **Status** — live progress is a tail of accumulated text *and* thought streams; empty/whitespace-only stream tokens floor to `running`.
- **Result** — plan jobs prefer harvested `plan.md` body over narration; finished jobs persist `config`, `usage`, and `artifacts` (v3 schema).
- **Reaper** — PID and process start time must match on Linux/macOS; Windows and legacy jobs fall back to PID checks. A dead process with a complete result is reconciled according to its exit status; missing/truncated results fail with diagnostics.
- **Timeout** — background jobs default to 60 minutes. `timeoutMinutes` overrides `GROK_JOB_TIMEOUT_MINUTES`; `0` disables it. Timeout terminates the process tree, records a failed result, and preserves partial output. Foreground calls are unaffected. Direct companion calls accept `--timeout-minutes`.
- **Retention** — setup cleans recorded terminal jobs older than 30 days and keeps at most 200 recent terminal jobs across the state root. Status-list calls also clean, at most once per 24 hours. Running jobs, live lock owners, and project artifacts are preserved. Setup reports the removal count.
- **Result size** — `grok_job action=result maxChars=20000` bounds the body by default; `0` disables truncation. Truncated output includes `truncated`, `totalChars`, `fullOutputPath`, and available artifact paths. The full output stays on disk. Companion flag: `--max-chars`.
- **Atomic writes** — background workers write `result.json` via tmp + rename (no partial mid-write; no leftover `.tmp.*` after success).
- **PR post-pending** — runs on background completion too; skips empty findings; empty/oversize diffs fail closed with recoverable findings under `.grok/reviews/`.

## CLI posture

- Prefer **denylist** (`--disallowed-tools`) over tools allowlist.
- Media: no yolo / no tools allowlist.
- `dryRun` / `validateOnly` / babysit `list`: **read-only** (no yolo).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override path to the `grok` CLI (also used by tests with a mock binary) |
| `GROK_CODEX_PLUGIN_STATE` | Explicit job-state root for this plugin |
| `CODEX_PLUGIN_DATA` | Host plugin data dir; trusted only when basename is `grok` / `grok-*` |
| `GROK_RESCUE_DEFAULT_WRITE` | Set to `1` to restore direct-write rescue by default; otherwise rescue defaults to a worktree |
| `GROK_JOB_TIMEOUT_MINUTES` | Background timeout, default `60`; `0` disables; tool parameter takes priority |
| `GROK_JOB_RETENTION_DAYS` | Terminal-job retention age in days, default `30` |
| `GROK_JOB_RETENTION_MAX` | Maximum retained terminal jobs, default `200` |

Default state root when unset: `~/.grok/codex-plugin/state/`. Codex does **not** share Claude’s `~/.grok/claude-plugin/state` or `GROK_CLAUDE_PLUGIN_STATE`.

## Usage notes

### Rescue

- **Behavior change in 0.7.0:** defaults to a Grok-managed isolated worktree when both `readOnly` and `worktree` are omitted. The underlying CLI must support `--worktree` and the project must support Git worktrees; failures do not fall back to direct writes.
- Use `readOnly=true` for investigation-only work.
- Explicit `worktree=false` or `readOnly=false` opts into direct writes when no worktree is requested. Explicit `worktree=true` overrides the environment opt-out; `readOnly=true` takes priority over worktree settings. Results report `executionMode` (`direct`, `worktree`, or `readOnly`).
- Direct companion `task` uses the same default. Use `--write`, `--worktree=false` or `--read-only=false` for direct writes, or `--read-only` to investigate.
- Use `check=true` for verification. `bestOfN > 1` requires CLI support for `--best-of-n`, checked before generation. Grok 1.0.34 rejects that flag; omit `bestOfN` or use `1` with that version.
- `check=true` appends a verification contract to the prompt (Grok CLI 1.x has no `--check` flag). That is implementer evidence, not host final acceptance.
- Full control surface available (sandbox, memory, agent, allow/deny, maxTurns, …).

### Host-led implement

- Required: `implementationBrief`, `acceptanceCriteria`.
- Always runs with `--check`. Optional structured fields: `allowedFiles`, `forbiddenChanges`, `verificationCommands`.
- Default `--model deep` only when model/effort are omitted; preserve explicit overrides.
- Resume the same session for corrections. Codex remains planner and final verifier.

### Plan / design / execute

- Plan mode harvests into `.grok/plans/`; result body prefers the plan file.
- Design harvests into `.grok/designs/`.
- `grok_execute_plan` with `latest=true` picks the newest design doc; `dryRun=true` is read-only.

### Review

- Read-only; never applies patches.
- `postPending=true` with a PR posts PENDING GitHub review comments when findings exist.

### Media

- Default outputs land under `.grok/media/image/` and `.grok/media/video/`.
- Session media is copied into those dirs when Grok leaves files in its session workspace.

### Jobs

- Background tools return a job id.
- Use `grok_job action=status` / `grok_job action=result` / `grok_job action=cancel` with that id when multiple jobs are active.

### Artifact discovery and migration preview

```text
grok_artifacts cwd="/path/to/project" action=discover json=true
grok_artifacts cwd="/path/to/project" action=preview maxEntries=10000 json=true
```

The equivalent CLI is `node plugins/grok/scripts/grok-companion.mjs artifacts preview --cwd /path/to/project --json`.
Discovery inventories known artifact directories in both layouts. Preview maps legacy files
to `.grok/plans/`, `.grok/designs/`, `.grok/workflows/`, `.grok/docs/`, `.grok/reviews/`, and
`.grok/media/`, preserving nested paths. Existing targets are conflicts even when their contents
might match. Symlinks and junctions are never followed; blocked parents and unreadable paths
are reported. Scans are capped at 10000 entries by default (configurable up to 100000) and 32
levels; `complete=false` and warnings indicate an incomplete inventory.

Both actions are read-only: no Grok invocation, job creation, directory creation, copies, moves,
Git-ignore updates, or reference rewrites. New generation defaults to the unified `.grok/` subdirectories; old artifacts stay in place.
Custom output locations and session/state files are outside this inventory. Preview is a
point-in-time proposal, not a migration approval or executable plan. See the
[migration design](docs/artifact-migration.md) for reference handling and rollback requirements.

## Development

GitHub Actions tests Node 18.18, 20 and 22 on Linux, macOS and Windows. Tests use local mock
processes and do not require Grok credentials or network access.

```bash
npm test
node plugins/grok/scripts/grok-companion.mjs setup --json
node plugins/grok/mcp/server.mjs   # stdio NDJSON MCP server
```

## Versioning

Run `npm run version:bump -- 0.8.0` with the intended new version. The script synchronizes root
`package.json`, the plugin manifest, and marketplace root/plugin-entry versions (and a metadata
version if present). Tests reject version drift. MCP reports the plugin manifest version.
Creating a Git tag or GitHub Release remains a maintainer action.

## Compatibility

Setup preserves the historical 0.2.118 version-floor check; a passing version check alone is
not evidence that every feature is available. It also runs `grok --help` and reports each CLI
flag as `supported`, `unsupported` (not advertised in recognizable help), or `unknown` (failed
or unrecognized help). Hidden flags and runtime behavior require separate verification.

The historical 0.2.x/1.x feature mapping is **unverified** for this release. The companion's
`check` feature injects verification instructions and never passes `--check` to Grok.
Worktree isolation is delegated to the CLI's `--worktree`; mock tests check argument handling,
not the behavior of every released Grok version. Setup lists the actual denylist strings for
read-only and media modes; direct-write, worktree and plan mode do not add that denylist.

## Windows and troubleshooting

- Set `GROK_BINARY` to an absolute path to `grok.exe` if discovery fails. Otherwise `where.exe grok.exe`
  must find it on the Codex process's `PATH`; the fallback is `%USERPROFILE%\.grok\bin\grok.exe`.
  Restart Codex after changing `PATH`.
- **cwd error:** pass your existing project directory explicitly, for example `cwd="D:\\Projects\\app"`.
- **Lock conflict:** use the owning job ID in `grok_job action=status` or `grok_job action=cancel`, then retry. Dead-owner
  locks are reclaimed automatically. Concurrent direct writes to the same repository are refused.
- **Timeout:** inspect the job's partial output/log, then increase `timeoutMinutes` or explicitly
  set it to `0`. Windows termination uses `taskkill /T /F` to include descendants.
- **Worktree unsupported/non-Git project:** inspect setup capability output and the CLI error.
  Explicitly select `readOnly=true` or `worktree=false` according to the intended task.

## License

Apache-2.0
