---
name: grok-routing
description: When Codex should delegate to Grok vs handle work itself
user-invocable: false
---

# When to call Grok

## Prefer Grok MCP tools

- **Host-led dual-model implementation** (Codex plans/decides/accepts, Grok implements) → `grok_implement`. Follow `grok-orchestrated-coding`. Do **not** use `grok_plan` / `grok_design` for that host-owned planning phase.
- Substantial debugging after Codex is stuck
- Second-opinion implementation of a non-trivial change
- Best-of-N alternative approaches (`bestOfN`)
- Risky edits that should land in a worktree (`worktree`)
- **Ambiguous architecture, Grok-owned planning** → `grok_plan` then implement, or `grok_design`
- **Multi-PR delivery from a design doc** → `grok_execute_plan`
- **Named multi-agent recipes** → `grok_workflow`
- **PR CI/review babysitting** → `grok_babysit`
- Image/video generation (`grok_media kind=image`, `grok_media kind=video`)
- Documents (`grok_document` with `type` pdf|docx|pptx)
- Structured or adversarial code review before shipping
- Long-running investigation better as a background job

## Prefer staying in Codex

- Quick questions, renames, one-line fixes
- Tiny edits with obvious answers
- Pure conversation without repo mutation

## Intent → tool

| User intent | Prefer |
| --- | --- |
| Codex plans, Grok implements, Codex verifies | `grok_implement` (host-led; not `grok_plan` / `grok_design`) |
| Stuck on a bug / implement a fix | `grok_rescue` (+ worktree + check) |
| Unclear approach; Grok should plan | `grok_plan` |
| Architecture / design doc + PR plan (Grok-owned) | `grok_design` |
| Ship a design doc’s PR DAG | `grok_execute_plan` (or `latest=true` after design) |
| Multi-dimension structured fan-out | `grok_workflow` |
| Ship quality on a branch/PR | `grok_review` (+ `postPending` for GH) |
| Challenge design assumptions | `grok_adversarial_review` |
| Watch / fix open PRs | `grok_babysit` |
| Deck / PDF / Word | `grok_document` |
| Brand stills / clips | `grok_media kind=image` / `grok_media kind=video` |
| Find past Grok work | `grok_sessions` |

## Host-led vs Grok-owned planning

When the user **explicitly** asks for Codex to plan and Grok to implement (including dual-model implementation briefs):

1. Codex reads the repo, captures baseline status, and writes the brief. **Do not** call `grok_plan` or `grok_design` for this phase.
2. Call **`grok_implement`**. Do not edit the same workspace while Grok runs.
3. Codex independently inspects git status/diff and re-runs checks. Never treat Grok output as final acceptance.

Use **`grok_plan` / `grok_design`** only when the user wants **Grok** to explore and propose the plan.

## Depth pipeline (multi-PR / ambiguous product work)

Prefer this sequence over a single giant rescue when **Grok** owns planning:

1. **`grok_plan`** — explore + plan.md when the approach is unclear (artifacts under `.grok/plans/`).
2. **`grok_design`** — consensus design doc + PR Plan → artifacts under `.grok/designs/`.
3. **`grok_execute_plan`** with `latest=true` (or explicit `designDoc`) — implement the PR DAG in worktrees.
4. **`grok_review`** / **`grok_babysit`** — quality and CI/review loop.

Use **`grok_workflow`** when you have a named multi-agent recipe (fan-out review dimensions, etc.), not ad-hoc parallel rescues.

## Memory and agent profiles

- Long multi-session work: prefer `memory=true` so Grok can reuse decisions.
- Codebase map / investigation without edits: `agent=explore` or `readOnly=true` + `sandbox=read-only`.
- Planning only: `grok_plan` or `planMode=true` on rescue.

## Parallel jobs

When workstreams are independent, **run multiple Grok jobs at once**:

| Need | Tool |
| --- | --- |
| Fix / investigate | `grok_rescue` |
| Host-led implement | `grok_implement` |
| Plan | `grok_plan` |
| Design | `grok_design` |
| Execute plan | `grok_execute_plan` |
| Workflow | `grok_workflow` |
| Review | `grok_review` |
| Babysit | `grok_babysit` |
| Document | `grok_document` |
| Image / video | `grok_media kind=image` / `grok_media kind=video` |

How:

1. Split into independent prompts.
2. For concurrent writers, assign non-overlapping `allowedFiles` and set `parallelWrite=true`, or give each writer its own worktree.
3. Start each MCP tool with `background=true` when it may take time.
4. Track each job id via `grok_job action=status`.
5. Collect results with `grok_job action=result` and do not finish while a required job is active.

Do **not** serialize independent Grok work just because another job is running.
Do **not** run concurrent writers against overlapping files or an ambiguous shared scope.

## Tool map

| Need | Tool |
| --- | --- |
| Setup | `grok_setup` |
| Fix / investigate | `grok_rescue` |
| Host-led implement | `grok_implement` |
| Plan mode | `grok_plan` |
| Design doc | `grok_design` |
| Execute PR plan | `grok_execute_plan` |
| Workflow | `grok_workflow` |
| Review | `grok_review` |
| Challenge design | `grok_adversarial_review` |
| Babysit PRs | `grok_babysit` |
| Document | `grok_document` |
| Image | `grok_media kind=image` |
| Video | `grok_media kind=video` |
| Sessions | `grok_sessions` |
| Progress | `grok_job action=status` |
| Output | `grok_job action=result` |
| Cancel | `grok_job action=cancel` |
| Handoff context | `grok_transfer` |
