---
name: grok-orchestrated-coding
description: Use when Codex should plan, decide, and accept while Grok implements a host-approved brief (dual-model implementation-brief workflows, "Codex plans Grok codes", host-led implement-then-verify). Not for Grok-owned grok_plan/grok_design.
user-invocable: true
---

# Host-led Codex → Grok implementation

Codex is the planner and final verifier. Grok implements a host-approved brief via `grok_implement`. Do not treat Grok narration, `--check`, or this MCP tool as host final acceptance.

Do **not** use `grok_plan` or `grok_design` for the initial host-owned planning phase. Those tools are for Grok-owned planning when the user wants Grok to explore and propose the approach.

## Workflow

1. **Baseline before writes.** Read repo instructions and the relevant code. Capture git status/diff and the current test/lint baseline. Do not start Grok until this exists.
2. **Write a concrete brief.** Codex decides the plan. The brief must include what to change, what not to change, and measurable acceptance criteria. Optional: `allowedFiles`, `forbiddenChanges`, `verificationCommands`.
3. **Call `grok_implement`.** Pass `cwd`, `implementationBrief`, and `acceptanceCriteria`. Use `resumeSession` / `resume` for same-session corrections; `fresh` only to start over.
4. **Do not write the same workspace while Grok runs.** No overlapping Codex edits, commits, or formatter passes on that tree. Prefer `background=true` and wait on `grok_status` / `grok_result`.
5. **Host verification.** Independently inspect `git status` and `git diff`. Re-run the appropriate tests/static checks yourself. Never trust Grok's report alone.
6. **Corrections.** Resume the same Grok session with a delta brief. Do not open a parallel implementer on the same files.
7. **Stop for authority.** Ask the user before destructive, external, production, database, or payment actions.
8. **Final response.** Report the host plan, the actual diff, verification you ran, and residual risk.

## `grok_implement` contract

- Maps to companion `task --check`.
- Defaults `--model deep` only when no `model` or `effort` is supplied. `deep` is an effort preset; it does not pin a model id. Preserve explicit `model` / `effort` overrides.
- Grok must implement the brief as written, inspect only to validate assumptions, and stop rather than improvise if constraints conflict.
- Implementer checks are evidence for the host, not acceptance.

## Example

```text
grok_implement cwd="/path/to/project" implementationBrief="Add full jitter to src/retry.ts per the host plan. Keep the public fetchWithRetry signature." acceptanceCriteria=["Retries use full jitter","Existing retry tests pass"] allowedFiles=["src/retry.ts","tests/retry.test.ts"] forbiddenChanges=["Do not change public API signatures"] verificationCommands=["npm test"]
```
