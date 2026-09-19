import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessDiffForPostPending,
  findingsToPendingReviewPayload,
  parseDiffRightLines,
  postPendingAlreadyDone,
  postPendingForFinishedJob,
  shouldSkipEmptyFindingsPost,
  wantsPostPending,
  writeRecoverableReviewFindings
} from "../plugins/grok/scripts/lib/review.mjs";

const FIXTURE_DIFF = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,4 @@
 line one
-line two old
+line two new
 line three
+line four added
`;

test("parseDiffRightLines collects right-side lines", () => {
  const right = parseDiffRightLines(FIXTURE_DIFF);
  assert.ok(right.has("src/foo.js:1"));
  assert.ok(right.has("src/foo.js:2")); // new line two
  assert.ok(right.has("src/foo.js:3"));
  assert.ok(right.has("src/foo.js:4")); // added
});

test("findingsToPendingReviewPayload omits event and partitions comments", () => {
  const payload = findingsToPendingReviewPayload({
    headSha: "abc123def",
    summary: "Looks mostly good",
    findings: [
      {
        severity: "high",
        title: "Bug on new line",
        body: "Null check missing",
        file: "src/foo.js",
        line_start: 2,
        recommendation: "Guard null"
      },
      {
        severity: "low",
        title: "Outside diff",
        body: "Old code smell",
        file: "src/foo.js",
        line_start: 999,
        recommendation: "N/A"
      }
    ],
    diffText: FIXTURE_DIFF
  });

  assert.equal(payload.commit_id, "abc123def");
  assert.equal(payload.event, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "event"));
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].path, "src/foo.js");
  assert.equal(payload.comments[0].line, 2);
  assert.equal(payload.comments[0].side, "RIGHT");
  assert.match(payload.comments[0].body, /Null check missing/);
  assert.match(payload.body, /Looks mostly good/);
  assert.match(payload.body, /Issues outside the diff/);
  assert.match(payload.body, /Outside diff/);
});

test("findingsToPendingReviewPayload requires headSha", () => {
  assert.throws(() => findingsToPendingReviewPayload({ summary: "x" }), /headSha/);
});

test("wantsPostPending reads config and wantPostPending flag", () => {
  assert.equal(wantsPostPending({ config: { postPending: true } }), true);
  assert.equal(wantsPostPending({ wantPostPending: true }), true);
  assert.equal(wantsPostPending({ config: { postPending: false } }), false);
  assert.equal(wantsPostPending(null), false);
});

test("postPendingAlreadyDone treats ok and skipped as done", () => {
  assert.equal(postPendingAlreadyDone({ ok: true }), true);
  assert.equal(postPendingAlreadyDone({ ok: true, skipped: true }), true);
  assert.equal(postPendingAlreadyDone({ ok: false, error: "x" }), false);
  assert.equal(postPendingAlreadyDone(null), false);
});

test("postPendingForFinishedJob is null when post-pending not requested", () => {
  const result = postPendingForFinishedJob({
    job: { config: { postPending: false } },
    review: { summary: "s", findings: [] }
  });
  assert.equal(result, null);
});

test("shouldSkipEmptyFindingsPost skips zero findings", () => {
  const s = shouldSkipEmptyFindingsPost({ summary: "clean", findings: [] });
  assert.equal(s.skip, true);
  assert.equal(s.reason, "no-findings");
});

test("assessDiffForPostPending rejects empty and oversize diffs", () => {
  const empty = assessDiffForPostPending("  \n");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty-diff");
  const big = assessDiffForPostPending("x".repeat(100), { maxBytes: 10 });
  assert.equal(big.ok, false);
  assert.equal(big.reason, "oversize-diff");
  assert.equal(assessDiffForPostPending(FIXTURE_DIFF).ok, true);
});

test("postPendingForFinishedJob skips empty findings without calling gh", () => {
  let called = 0;
  const result = postPendingForFinishedJob({
    job: {
      id: "review-empty",
      config: { postPending: true },
      reviewTarget: { pr: 1, headSha: "h", owner: "o", repo: "r", diff: FIXTURE_DIFF }
    },
    review: { summary: "clean", findings: [] },
    runCommandFn: () => {
      called += 1;
      return { status: 0, stdout: "{}", stderr: "" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no-findings");
  assert.equal(called, 0);
});

test("postPendingForFinishedJob skips empty-diff and writes recoverable findings", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rev-"));
  const result = postPendingForFinishedJob({
    job: {
      id: "review-emptydiff",
      config: { postPending: true },
      reviewTarget: { pr: 1, headSha: "h", owner: "o", repo: "r", diff: "" }
    },
    review: {
      summary: "s",
      findings: [
        {
          severity: "high",
          title: "t",
          body: "b",
          file: "src/foo.js",
          line_start: 2
        }
      ]
    },
    cwd: tmp,
    runCommandFn: () => {
      throw new Error("should not call gh");
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "empty-diff");
  assert.ok(result.findingsPath);
  assert.ok(fs.existsSync(result.findingsPath));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeRecoverableReviewFindings writes JSON", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-rec-"));
  const file = writeRecoverableReviewFindings(
    tmp,
    "job-1",
    { verdict: "ok", summary: "s", findings: [], next_steps: [] }
  );
  assert.ok(file);
  assert.equal(file, path.join(tmp, '.grok', 'reviews', 'job-1-findings.json'));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.jobId, "job-1");
  assert.equal(parsed.summary, "s");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("postPendingForFinishedJob posts for background-style job (config.postPending)", () => {
  // Simulates background finalize: only job.config.postPending + reviewTarget, no foreground path
  const job = {
    config: { postPending: true },
    reviewTarget: {
      pr: 42,
      owner: "acme",
      repo: "widgets",
      headSha: "abc123",
      diff: FIXTURE_DIFF
    }
  };
  const review = {
    summary: "Looks ok",
    findings: [
      {
        severity: "high",
        title: "Bug",
        body: "Null",
        file: "src/foo.js",
        line_start: 2,
        recommendation: "fix"
      }
    ]
  };

  const calls = [];
  const runCommandFn = (cmd, args) => {
    calls.push({ cmd, args });
    // gh api POST reviews
    if (args.includes("api") && args.some((a) => String(a).includes("/reviews"))) {
      return {
        status: 0,
        stdout: JSON.stringify({ id: 99, html_url: "https://example.com" }),
        stderr: ""
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };

  const result = postPendingForFinishedJob({
    job,
    review,
    runCommandFn
  });

  assert.equal(result.ok, true);
  assert.equal(result.reviewId, 99);
  assert.match(result.url, /acme\/widgets\/pull\/42\/files/);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].cmd, "gh");
  assert.ok(calls[0].args.includes("api"));
  // Must not require gh pr view when metadata already on job
  assert.ok(!calls.some((c) => c.args.includes("view")));
});

test("postPendingForFinishedJob does not re-post when already ok", () => {
  let called = 0;
  const result = postPendingForFinishedJob({
    job: {
      config: { postPending: true },
      postPending: { ok: true, url: "https://already" },
      reviewTarget: { pr: 1 }
    },
    review: { summary: "s", findings: [{ severity: "low", title: "t", body: "b", file: "f", line_start: 1 }] },
    runCommandFn: () => {
      called += 1;
      return { status: 0, stdout: "{}", stderr: "" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://already");
  assert.equal(called, 0);
});

test("postPendingForFinishedJob resolves metadata via gh pr view when missing", () => {
  const job = {
    config: { postPending: true },
    reviewTarget: {
      pr: 7,
      diff: FIXTURE_DIFF
    }
  };
  const review = {
    summary: "s",
    findings: [
      {
        severity: "medium",
        title: "t",
        body: "b",
        file: "src/foo.js",
        line_start: 2
      }
    ]
  };
  const runCommandFn = (cmd, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          headRefOid: "deadbeef",
          headRepository: { name: "repo" },
          headRepositoryOwner: { login: "org" }
        }),
        stderr: ""
      };
    }
    if (args.includes("api")) {
      return { status: 0, stdout: JSON.stringify({ id: 1 }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "fail" };
  };
  const result = postPendingForFinishedJob({ job, review, runCommandFn });
  assert.equal(result.ok, true);
  assert.match(result.url, /org\/repo\/pull\/7/);
});
