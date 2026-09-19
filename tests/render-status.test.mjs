import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/grok/scripts/lib/render.mjs";

test("renderStatusReport single job shows usage postPending artifacts", () => {
  const text = renderStatusReport(
    [
      {
        id: "review-1",
        kind: "review",
        status: "completed",
        title: "PR review",
        usage: { num_turns: 3, total_tokens: 1000, total_cost_usd: 0.02 },
        postPending: {
          ok: true,
          skipped: true,
          reason: "no-findings"
        },
        artifacts: [
          { kind: "design-copy", path: "/proj/.grok-designs/x.md" },
          { kind: "design", path: "/tmp/x.md" }
        ]
      }
    ],
    { jobId: "review-1" }
  );
  assert.match(text, /Usage/);
  assert.match(text, /turns 3/);
  assert.match(text, /Post-pending/);
  assert.match(text, /skipped/);
  assert.match(text, /Artifacts/);
  assert.match(text, /\.grok-designs\/x\.md/);
});

test("renderStatusReport shows semantic tool progress instead of stale thought text", () => {
  const job = {
    id: "task-progress",
    kind: "task",
    status: "running",
    title: "Implement change",
    progress: {
      phase: "editing",
      message: "thinking: parsing the implementation brief again",
      lastTool: {
        name: "write_file",
        kind: "write",
        status: "completed",
        updatedAt: "2026-09-19T03:25:33.508Z"
      },
      toolCounts: { read: 5, write: 2 }
    }
  };
  const detail = renderStatusReport([job], { jobId: job.id });
  assert.match(detail, /Phase\*\*: editing/);
  assert.match(detail, /Last tool\*\*: write_file \(write, completed\)/);
  assert.match(detail, /Tool calls\*\*: read 5, write 2/);

  const list = renderStatusReport([job]);
  assert.match(list, /editing: write_file/);
  assert.doesNotMatch(list, /parsing the implementation brief/);
});

test("renderTaskResult shows recoverable findings path on failed post", () => {
  const text = renderTaskResult({
    jobId: "review-2",
    kind: "review",
    status: "completed",
    write: false,
    text: "review done",
    postPending: {
      ok: false,
      error: "gh api exited 422",
      findingsPath: "/proj/.grok-reviews/review-2-findings.json"
    }
  });
  assert.match(text, /GitHub pending review/);
  assert.match(text, /Posted\*\*: no/);
  assert.match(text, /Recoverable findings/);
  assert.match(text, /review-2-findings\.json/);
});

test("renderTaskResult with structured review still shows usage postPending artifacts", () => {
  // Hits renderStructuredReview path (payload.review set) — real finalizeJob review results.
  const text = renderTaskResult({
    jobId: "review-structured",
    kind: "review",
    status: "completed",
    write: false,
    text: "structured",
    review: {
      verdict: "request_changes",
      summary: "One issue found",
      findings: [
        {
          severity: "high",
          title: "Null deref",
          body: "x can be null",
          file: "src/a.ts",
          line_start: 10,
          recommendation: "Guard"
        }
      ],
      next_steps: ["Add test"]
    },
    usage: { num_turns: 4, total_tokens: 2000, total_cost_usd: 0.05 },
    postPending: {
      ok: false,
      error: "gh api exited 422",
      findingsPath: "/proj/.grok-reviews/review-structured-findings.json"
    },
    artifacts: [{ kind: "design-copy", path: "/proj/.grok-designs/doc.md", label: "design" }]
  });
  assert.match(text, /Verdict/);
  assert.match(text, /Null deref/);
  assert.match(text, /## Usage/);
  assert.match(text, /Turns/);
  assert.match(text, /## GitHub pending review/);
  assert.match(text, /Recoverable findings/);
  assert.match(text, /review-structured-findings\.json/);
  assert.match(text, /## Artifacts/);
  assert.match(text, /\.grok-designs\/doc\.md/);
});

test("renderStoredJobResult with review includes enrichment (real result path)", () => {
  const text = renderStoredJobResult({
    id: "review-job",
    kind: "review",
    status: "completed",
    resultText: "done",
    review: {
      verdict: "approve",
      summary: "Looks good",
      findings: [],
      next_steps: []
    },
    usage: { num_turns: 2, total_tokens: 100, total_cost_usd: 0.01 },
    postPending: { ok: true, skipped: true, reason: "no-findings", message: "No issues" },
    artifacts: [{ kind: "file", path: "/proj/out.md" }]
  });
  assert.match(text, /approve|Looks good/);
  assert.match(text, /## Usage/);
  assert.match(text, /Post-pending|GitHub pending|skipped/i);
  assert.match(text, /## Artifacts|out\.md/);
});

test("renderStoredJobResult includes usage from job", () => {
  const text = renderStoredJobResult({
    id: "task-1",
    kind: "task",
    status: "completed",
    resultText: "hello",
    usage: { num_turns: 1, total_tokens: 50, total_cost_usd: 0.001 }
  });
  assert.match(text, /Usage/);
  assert.match(text, /Turns/);
});

test("renderStoredJobResult for plan prefers plan.md over narration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plan-render-"));
  const planPath = path.join(tmp, "plan.md");
  fs.writeFileSync(
    planPath,
    "# Context\n\nImplement exponential backoff with jitter.\n"
  );
  const text = renderStoredJobResult({
    id: "plan-bg",
    kind: "plan",
    status: "completed",
    resultText: "Entering plan mode and exploring...",
    artifacts: [{ kind: "plan-copy", path: planPath }]
  });
  assert.match(text, /exponential backoff/);
  assert.match(text, /Plan \(from plan\.md\)|Context/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
