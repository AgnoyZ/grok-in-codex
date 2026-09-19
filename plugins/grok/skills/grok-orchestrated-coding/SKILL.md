---
name: grok-orchestrated-coding
description: Use when Codex should plan, decide, and accept while Grok implements a host-approved brief (dual-model implementation-brief workflows, "Codex plans Grok codes", host-led implement-then-verify). Not for Grok-owned grok_plan/grok_design.
user-invocable: true
---

# Host-led Codex → Grok implementation

Codex is the planner and final verifier. Grok implements a host-approved brief via `grok_implement`. Do not treat Grok narration, `--check`, or this MCP tool as host final acceptance.

Do **not** use `grok_plan` or `grok_design` for the initial host-owned planning phase. Those tools are for Grok-owned planning when the user wants Grok to explore and propose the approach.

## Workflow

1. **Classify the task.** Stay in Codex for a genuinely small, localized change. Use this workflow when implementation benefits from a bounded second model, independent execution context, worktree isolation, or a correction loop. Do not invoke Grok mechanically for every multi-file task.
2. **Baseline before writes.** Read repo instructions and the relevant code. Capture git status/diff and the current test/lint baseline. Do not start Grok until this exists.
3. **Write a concrete brief.** Codex decides the plan. The brief must include objective, scope, constraints, deliverable, and measurable acceptance criteria. Optional: `allowedFiles`, `forbiddenChanges`, `verificationCommands`.
4. **Call `grok_implement`.** Pass `cwd`, `implementationBrief`, and `acceptanceCriteria`. Use `resumeSession` / `resume` for same-session corrections; `fresh` only to start over.
5. **Do not write the same workspace while Grok runs.** No overlapping Codex edits, commits, or formatter passes on that tree. Prefer `background=true` and wait on `grok_job action=status` / `grok_job action=result`.
6. **Host verification.** Independently inspect `git status` and `git diff`. Re-run the appropriate tests/static checks yourself. Never trust Grok's report alone.
7. **Corrections.** Resume the same Grok session with a delta brief. Set `correctionAttempt` and keep the default maximum of two rounds unless the task justifies another explicit bound. Do not open a parallel implementer on the same files. If the bound is exhausted, stop and report the unresolved acceptance criteria.
8. **Independent review when risk warrants it.** Use `grok_review` or `grok_adversarial_review` after implementation for security-sensitive, concurrency-heavy, data-integrity, compatibility, or broad architectural changes. Review is evidence; Codex still owns acceptance.
9. **Stop for authority.** Ask the user before destructive, external, production, database, or payment actions.
10. **Apply the completion gate and report.** Do not finish until all required jobs are terminal, material findings are resolved or disclosed, the final diff is inspected, and host verification is recorded. Report the host plan, actual diff, verification, and residual risk.

## Parallel write ownership

- Prefer one writer per file or subsystem.
- Spawn independent write jobs together only when their ownership does not overlap.
- Set `parallelWrite=true` for every concurrent writer.
- Give each writer explicit `allowedFiles`, or isolate it with `worktree=true` / `worktreeName`.
- If ownership cannot be separated, serialize the work.
- Stop rather than crossing another writer's ownership or merging conflicting edits implicitly.

## Failure handling

When implementation or verification fails:

1. Identify which acceptance criteria remain unmet.
2. Resume the same session with a narrow delta brief and `correctionAttempt`.
3. Preserve already accepted work; do not restart with `fresh` merely to hide a failed attempt.
4. Stop and return control to the user when the correction bound is exhausted or the fix requires a new architecture, dependency, public API, schema, production action, or broader authority.

## Completion gate

Before claiming completion, Codex must confirm:

- every required Grok job completed or explicitly failed
- no required background job remains active
- the final diff matches the approved scope and contains no unexplained files
- each acceptance criterion is pass, fail, or unverified with evidence
- the highest-value tests/static checks were independently re-run by Codex
- material review findings were resolved or disclosed
- remaining risks and unperformed validation are stated

## `grok_implement` contract

- Maps to companion `task --check`.
- Defaults `--model deep` only when no `model` or `effort` is supplied. `deep` is an effort preset; it does not pin a model id. Preserve explicit `model` / `effort` overrides.
- Grok must implement the brief as written, inspect only to validate assumptions, and stop rather than improvise if constraints conflict.
- Implementer checks are evidence for the host, not acceptance.
- `parallelWrite=true` requires either worktree isolation or explicit `allowedFiles` ownership.
- `correctionAttempt` requires `resume` / `resumeSession` and cannot exceed `maxCorrectionAttempts`.

## Example

```text
grok_implement cwd="/path/to/project" implementationBrief="Add full jitter to src/retry.ts per the host plan. Keep the public fetchWithRetry signature." acceptanceCriteria=["Retries use full jitter","Existing retry tests pass"] allowedFiles=["src/retry.ts","tests/retry.test.ts"] forbiddenChanges=["Do not change public API signatures"] verificationCommands=["npm test"]
```
