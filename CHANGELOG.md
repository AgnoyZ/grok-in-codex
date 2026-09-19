# Changelog

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] - 2026-09-19

### Added
- Node 18.18/20/22 CI on Linux, macOS and Windows (T1).
- `npm run version:bump -- <version>` and version consistency tests (T2).
- Atomic workspace write locks with stale-owner recovery and background ownership handoff (T4).
- PID start-time identity on Linux/macOS, retaining legacy/Windows PID fallback (T6).
- Terminal-job cleanup, 30-day/200-job defaults, configurable retention and daily status throttling (T7).
- Background `timeoutMinutes` / `GROK_JOB_TIMEOUT_MINUTES`, default 60 minutes; partial results survive timeout (T8).
- Result `maxChars`, default 20000, with full-output and artifact paths when truncated (T9).
- Setup CLI help capability report and exact per-mode `--disallowed-tools` values (T11).

### Changed
- **Behavior change (T5):** rescue defaults to an isolated worktree unless `readOnly` or `worktree` is explicitly supplied. `GROK_RESCUE_DEFAULT_WRITE=1` restores the old default. Results expose the execution mode. Explicit read-only mode takes priority.
- Write tools reject implicit plugin-installation cwd; path errors include repair guidance (T3).
- Setup adds `.grok-*/` to the repository-local Git exclude file idempotently (T10).
- MCP version follows the plugin manifest; documented new settings and Windows troubleshooting (T12).

### Fixed
- Windows process-tree termination includes descendants.
- Running job index entries are no longer discarded by the completed-history limit.

## 0.6.0

### Added
- **Host-led implementation (`grok_implement`)**: Codex plans and verifies; Grok implements a host-approved brief via companion `task --check`. Defaults to the `deep` effort preset when no model or effort is supplied (`deep` does not pin a model id). Same-session corrections via `resumeSession` / `resume`.
- **`grok-orchestrated-coding` skill**: host-led dual-model workflow (baseline, brief, implement, independent host verify). Distinct from Grok-owned `grok_plan` / `grok_design`.

### Improved
- **`check=true` on `grok_rescue`**: appends a verification contract to the prompt before the prompt file is written. Grok CLI 1.x still has no `--check` flag. Implementer checks are not host final acceptance.

## 0.5.9

### Fixed
- **Grok CLI 1.x compatibility**: discover `grok.exe` on Windows, use `--always-approve`, and stop forwarding the removed `--check` flag.
- **Dynamic model selection**: `fast` and `deep` now adjust reasoning effort while inheriting the model configured in Grok CLI; explicit model IDs still override it.
- **Authentication fallback**: accept existing credentials when the remote model catalog times out.
- **Runtime vocabulary**: use the supported `workspace` sandbox profile in MCP guidance.

## 0.5.8

### Fixed
- **MCP workspace scoping**: every tool accepts `cwd` so installed-plugin MCP calls run against the active project (not the plugin cache). Companion spawn uses that directory for jobs, git, and artifacts.

### Notes
- Behavioral parity with grok-in-claude **v0.5.7** retained; this release is Codex-host-specific.


## 0.5.7

### Fixed
- **Live progress floor**: whitespace-only stream tokens no longer blank status; helper returns empty until real content, call sites use `|| "running"`.

### Parity
- Feature parity with [grok-in-claude](https://github.com/stdevMac/grok-in-claude) v0.5.7 mapped to Codex MCP tools + skills.

## 0.5.6

### Fixed
- **Progress helper coverage**: embed `formatStreamProgressMessage` source into the background worker (no drifted copy); tests assert against the embedded string.
- **Version lockstep**: marketplace metadata + plugin entry share package/plugin version.

## 0.5.5

### Fixed
- **Live progress (thinking)**: status tails accumulated `thought` stream events the same way as text.

## 0.5.4

### Fixed
- **Zombie background jobs**: `hasResultFile` requires a complete parseable `result.json` (not mere exists); corrupt/truncated files fail cleanly instead of staying `running` forever.
- **Atomic result write**: background wrapper writes via tmp + `renameSync` so partial files never appear as complete.
- **Live progress**: status message uses a tail of accumulated text, not only the last streamed token.

## 0.5.3

### Fixed
- **Background result race**: do not reaper-fail when complete `result.json` exists; reconcile false-failed jobs on status/result so plan.md is harvested.
- **Plan result text**: apply `preferPlanArtifactText` on all plan result render paths.
- **Session path keys**: try `/var` and `/private/var` encodings when locating session artifacts (macOS).
- **Plugin data trust**: only trust this plugin’s data dirs / `GROK_CODEX_PLUGIN_STATE` / `~/.grok/codex-plugin/state` (reject foreign host plugin dirs).

## 0.5.2

### Fixed
- **expandArgv** + array options (`--allow` / `--deny`) for control surface parsing.
- **`--dry-run` / `--validate-only`**: no longer grant `--yolo` (read-only tool posture).
- **babysit list**: read-only (no yolo); add/check/remove remain write-capable.
- **status log tail**: truncates multi-KB NDJSON `available_commands` lines.

## 0.5.1

### Added
- Design / workflow / plan / document artifact harvest helpers.
- `execute-plan --latest` resolves newest design under `.grok-designs/`.
- Post-pending policy: skip empty findings; empty/oversize diff guards; recoverable findings under `.grok-reviews/`.
- Status/result show usage and artifact paths.
- Mock Grok binary finish-path tests (`tests/helpers/mock-grok.mjs`).
- Routing skill: plan → design → execute-plan depth pipeline.

### Improved
- Stop-gate / setup min CLI version floor (`0.2.118`), denylist posture.
- README documents artifact dirs, control flags, and state env.

## 0.5.0

### Added (depth surface + reliability)
- MCP tools: `grok_plan`, `grok_workflow`, `grok_design`, `grok_execute_plan`, `grok_babysit`, `grok_document`, `grok_sessions`.
- Control surface on long-running jobs: sandbox, plan/permission-mode, agent, no-subagents, memory, allow/deny, disable-web-search, fork-session, max-turns.
- Job schema v3: `config`, `usage`, `artifacts` on finished jobs.
- Background review post-pending finalize path.
- Reliability: complete-result reaper, atomic result write, stream progress accumulate, plan text preference.

## 0.1.0

### Added
- Initial Codex MCP plugin: setup, rescue, review, adversarial review, image, video, status, result, cancel, transfer.
