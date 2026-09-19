import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = path.resolve(
  fileURLToPath(new URL("../../schemas/review-output.schema.json", import.meta.url))
);

export function readReviewSchema() {
  return fs.readFileSync(SCHEMA_PATH, "utf8");
}

export function getReviewSchemaPath() {
  return SCHEMA_PATH;
}

export function buildStructuredReviewPrompt(target, focusText, { adversarial = false } = {}) {
  const focus = focusText?.trim()
    ? `\n\nAdditional review focus from the user:\n${focusText.trim()}\n`
    : "";

  const mode = adversarial
    ? `You are performing an adversarial, steerable code review.
Challenge the design, tradeoffs, hidden assumptions, failure modes, and safer alternatives.
Do not rubber-stamp. Prefer findings that question whether this was the right approach.`
    : `You are performing a thorough read-only code review.
Focus on bugs, regressions, security issues, missing tests, and maintainability risks.`;

  return `${mode}

Do not modify files. Do not implement fixes.

Review target: ${target.label}
${target.branch ? `Current branch: ${target.branch}` : ""}
${target.baseRef ? `Base ref: ${target.baseRef}` : ""}
${target.pr ? `Pull request: #${target.pr}` : ""}

## Git status / summary
${target.status || "(clean)"}

## Diff
${target.diff || "(no diff content captured; inspect the repository with read-only tools if needed)"}
${focus}
## Output contract
Return ONLY JSON matching the provided schema with:
- verdict
- summary
- findings[] with severity, title, body, file, optional line_start/line_end, recommendation
- next_steps[]

Order findings by severity (critical > high > medium > low).
If there are no issues, return an empty findings array and a clear approve-style verdict.`;
}

export function tryParseStructuredReview(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidates.unshift(fenced[1].trim());
  }

  // Sometimes model returns prose + JSON object
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.verdict === "string" &&
        typeof parsed.summary === "string" &&
        Array.isArray(parsed.findings) &&
        Array.isArray(parsed.next_steps)
      ) {
        return normalizeReview(parsed);
      }
    } catch {
      // try next
    }
  }
  return null;
}

function normalizeReview(data) {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = data.findings.map((finding, index) => {
    const source = finding && typeof finding === "object" ? finding : {};
    const lineStart =
      Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
    const lineEnd =
      Number.isInteger(source.line_end) && source.line_end > 0 ? source.line_end : lineStart;
    return {
      severity:
        typeof source.severity === "string" && source.severity.trim()
          ? source.severity.trim().toLowerCase()
          : "low",
      title:
        typeof source.title === "string" && source.title.trim()
          ? source.title.trim()
          : `Finding ${index + 1}`,
      body:
        typeof source.body === "string" && source.body.trim()
          ? source.body.trim()
          : "No details provided.",
      file:
        typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
      line_start: lineStart,
      line_end: lineEnd,
      recommendation:
        typeof source.recommendation === "string" ? source.recommendation.trim() : ""
    };
  });

  findings.sort(
    (a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9)
  );

  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings,
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

export function reviewHasBlockingFindings(review) {
  if (!review) {
    return false;
  }
  return review.findings.some((f) => f.severity === "critical" || f.severity === "high");
}

/**
 * Walk a unified diff and collect (file, line) pairs present on the RIGHT side
 * (context lines and additions). Used to validate GitHub inline review comments.
 */
export function parseDiffRightLines(diffText) {
  const right = new Set();
  let currentFile = null;
  let rightLine = 0;

  const lines = String(diffText || "").split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      if (rest === "/dev/null") {
        currentFile = null;
      } else {
        currentFile = rest.replace(/^b\//, "");
      }
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile) {
      continue;
    }
    if (line.startsWith("\\")) {
      // e.g. \ No newline at end of file
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      right.add(`${currentFile}:${rightLine}`);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      // left-only; do not increment right
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      // context
      if (line.startsWith(" ") || line === "") {
        right.add(`${currentFile}:${rightLine}`);
        rightLine += 1;
      }
    }
  }
  return right;
}

/**
 * Build a GitHub PENDING pull request review payload (omit `event`).
 * Findings with (file, line) present on the right side of the diff become
 * inline comments; others are promoted to the review body.
 */
export function findingsToPendingReviewPayload({
  headSha,
  summary,
  findings = [],
  diffRightLines = null,
  diffText = null
} = {}) {
  if (!headSha) {
    throw new Error("headSha is required for pending review payload");
  }

  const right =
    diffRightLines instanceof Set
      ? diffRightLines
      : diffText
        ? parseDiffRightLines(diffText)
        : new Set();

  const inline = [];
  const promoted = [];
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const finding of findings) {
    const severity = String(finding.severity || "low").toLowerCase();
    if (severityCounts[severity] != null) {
      severityCounts[severity] += 1;
    }
    const file = finding.file || "unknown";
    const line = finding.line_start || finding.line || null;
    const key = line != null ? `${file}:${line}` : null;
    const bodyParts = [
      `**[${severity}]** ${finding.title || "Finding"}`,
      "",
      finding.body || ""
    ];
    if (finding.recommendation) {
      bodyParts.push("", `**Suggestion:** ${finding.recommendation}`);
    }
    const commentBody = bodyParts.join("\n").trim();

    if (key && right.has(key)) {
      inline.push({
        path: file,
        line: Number(line),
        side: "RIGHT",
        body: commentBody
      });
    } else {
      promoted.push({
        severity,
        file,
        line,
        title: finding.title,
        body: finding.body,
        recommendation: finding.recommendation
      });
    }
  }

  const bodySections = [
    "## Summary",
    "",
    summary || "Grok structured review",
    "",
    "## Issue counts by severity",
    "",
    `- critical: ${severityCounts.critical}`,
    `- high: ${severityCounts.high}`,
    `- medium: ${severityCounts.medium}`,
    `- low: ${severityCounts.low}`
  ];

  if (promoted.length) {
    bodySections.push(
      "",
      "## Issues outside the diff",
      "",
      "These findings reference lines not present in the diff and could not be posted as inline comments:",
      ""
    );
    for (const item of promoted) {
      bodySections.push(
        `- **[${item.severity}]** ${item.file}${item.line != null ? `:${item.line}` : ""} — ${item.title || item.body || ""}`
      );
      if (item.recommendation) {
        bodySections.push(`  - **Suggestion:** ${item.recommendation}`);
      }
    }
  }

  // Intentionally omit `event` so GitHub creates a PENDING review.
  return {
    commit_id: headSha,
    body: bodySections.join("\n"),
    comments: inline
  };
}

/** Default max unified-diff bytes for a useful GitHub review post. */
export const DEFAULT_POST_PENDING_MAX_DIFF_BYTES = 1_000_000;

/**
 * Whether a finished job should attempt GitHub PENDING review post.
 */
export function wantsPostPending(job) {
  if (!job) {
    return false;
  }
  if (job.config?.postPending || job.wantPostPending) {
    return true;
  }
  return false;
}

/**
 * True if a previous post attempt already succeeded or was intentionally skipped.
 */
export function postPendingAlreadyDone(postPending) {
  if (!postPending || typeof postPending !== "object") {
    return false;
  }
  return Boolean(postPending.ok === true || postPending.skipped === true);
}

/**
 * Guard empty / oversize diffs before a GitHub PENDING post.
 * @returns {{ ok: true } | { ok: false, skipped: true, reason: string, message: string }}
 */
export function assessDiffForPostPending(
  diffText,
  { maxBytes = DEFAULT_POST_PENDING_MAX_DIFF_BYTES } = {}
) {
  const text = String(diffText ?? "");
  if (!text.trim()) {
    return {
      ok: false,
      skipped: true,
      reason: "empty-diff",
      message: "Nothing to post: review target diff is empty."
    };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    return {
      ok: false,
      skipped: true,
      reason: "oversize-diff",
      message: `Diff is too large for a useful PENDING review (${bytes} bytes > ${maxBytes}). Narrow the PR or post findings manually.`
    };
  }
  return { ok: true, bytes };
}

/**
 * Skip policy: zero findings → do not create an empty GitHub PENDING review.
 */
export function shouldSkipEmptyFindingsPost(review) {
  if (!review || !Array.isArray(review.findings)) {
    return { skip: true, reason: "missing-findings", message: "Missing structured review findings" };
  }
  if (review.findings.length === 0) {
    return {
      skip: true,
      reason: "no-findings",
      message: "Reviewer found no issues; skipping empty GitHub PENDING review."
    };
  }
  return { skip: false };
}

/**
 * Persist structured findings on disk for recovery when GitHub post fails.
 * Returns absolute path or null.
 */
export function writeRecoverableReviewFindings(cwd, jobId, review, { tmpDir = null } = {}) {
  if (!review || !jobId) {
    return null;
  }
  const base =
    tmpDir ||
    path.join(cwd, ".grok/reviews");
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, `${jobId}-findings.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        jobId,
        savedAt: new Date().toISOString(),
        verdict: review.verdict ?? null,
        summary: review.summary ?? null,
        findings: review.findings ?? [],
        next_steps: review.next_steps ?? []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
}

/**
 * Build payload and post PENDING review for a completed review job.
 * runCommandFn(cmd, args, opts) -> { status, stdout, stderr } (defaults to null — must inject).
 *
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, error?: string, url?: string, reviewId?: string, findingsPath?: string } | null}
 *   null means "do not post" (not requested).
 */
export function postPendingForFinishedJob(
  { job, review, cwd = process.cwd(), runCommandFn = null, target = null } = {}
) {
  if (!wantsPostPending(job)) {
    return null;
  }
  if (postPendingAlreadyDone(job.postPending)) {
    return job.postPending;
  }
  if (!review || !Array.isArray(review.findings)) {
    return { ok: false, error: "Missing structured review findings" };
  }

  const emptySkip = shouldSkipEmptyFindingsPost(review);
  if (emptySkip.skip) {
    return {
      ok: true,
      skipped: true,
      reason: emptySkip.reason,
      message: emptySkip.message
    };
  }

  const pr = target?.pr || job.reviewTarget?.pr;
  if (!pr) {
    return { ok: false, error: "Missing PR number for --post-pending" };
  }

  const diffText = target?.diff || job.reviewTarget?.diff || "";
  const diffGuard = assessDiffForPostPending(diffText);
  if (!diffGuard.ok) {
    const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
    return {
      ok: false,
      skipped: true,
      reason: diffGuard.reason,
      error: diffGuard.message,
      message: diffGuard.message,
      findingsPath
    };
  }

  if (typeof runCommandFn !== "function") {
    const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
    return {
      ok: false,
      error: "No command runner available for gh",
      findingsPath
    };
  }

  try {
    let owner = target?.owner || job.reviewTarget?.owner || null;
    let repo = target?.repo || job.reviewTarget?.repo || null;
    let headSha = target?.headSha || job.reviewTarget?.headSha || null;

    if (!owner || !repo || !headSha) {
      const meta = runCommandFn(
        "gh",
        [
          "pr",
          "view",
          String(pr),
          "--json",
          "number,url,headRefOid,headRepository,headRepositoryOwner"
        ],
        { cwd, maxBuffer: 2 * 1024 * 1024 }
      );
      if (meta.status !== 0) {
        const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
        return {
          ok: false,
          error: String(meta.stderr || meta.stdout || "gh pr view failed").trim(),
          findingsPath
        };
      }
      const parsed = JSON.parse(String(meta.stdout || "{}"));
      headSha = headSha || parsed.headRefOid;
      const url = parsed.url || "";
      const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
      owner = owner || m?.[1] || parsed.headRepositoryOwner?.login;
      repo = repo || m?.[2] || parsed.headRepository?.name;
    }

    if (!headSha || !owner || !repo) {
      const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
      return {
        ok: false,
        error: `Unable to resolve PR metadata (owner=${owner}, repo=${repo}, headSha=${headSha})`,
        findingsPath
      };
    }

    const payload = findingsToPendingReviewPayload({
      headSha,
      summary: review.summary,
      findings: review.findings,
      diffText
    });

    const posted = postPendingReviewWithRunner(
      { owner, repo, prNumber: pr, payload },
      runCommandFn
    );
    if (!posted.ok) {
      const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
      return { ...posted, findingsPath };
    }
    return posted;
  } catch (err) {
    const findingsPath = writeRecoverableReviewFindings(cwd, job.id, review);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      findingsPath
    };
  }
}

/**
 * Write review payload JSON to a temp file; returns path.
 */
export function writeReviewPayloadFile(payload, tmpDir = null) {
  const base =
    tmpDir ||
    process.env.TMPDIR ||
    process.env.TMP ||
    path.join(process.cwd(), ".grok-companion");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "grok-review-"));
  const file = path.join(dir, "payload.json");
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

/**
 * Injectable runner for gh post (unit tests / companion).
 * runCommandFn(cmd, args, opts) -> { status, stdout, stderr }
 */
export function postPendingReviewWithRunner(
  { owner, repo, prNumber, payload },
  runCommandFn,
  tmpPath = null
) {
  const inputPath = tmpPath || writeReviewPayloadFile(payload);
  const result = runCommandFn(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      "-X",
      "POST",
      "--input",
      inputPath
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.status !== 0) {
    return {
      ok: false,
      error: stderr || stdout || `gh api exited ${result.status}`,
      status: result.status,
      payloadPath: inputPath
    };
  }
  let response = null;
  try {
    response = JSON.parse(stdout);
  } catch {
    response = { raw: stdout };
  }
  return {
    ok: true,
    url: `https://github.com/${owner}/${repo}/pull/${prNumber}/files`,
    response,
    reviewId: response?.id ?? null,
    payloadPath: inputPath
  };
}
