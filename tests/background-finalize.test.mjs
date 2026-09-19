import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const COMPANION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok/scripts/grok-companion.mjs"
);

/**
 * End-to-end: reaper false-failed background plan + valid result.json →
 * /result reconciles to completed and harvests plan.md into .grok/plans/.
 */
test("result reconciles reaper-failed plan with result.json and harvests plan.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bg-fin-"));
  const stateRoot = path.join(root, "state");
  let cwd = path.join(root, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  // Minimal git repo for workspace root resolution
  const init = spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(gitRoot.status, 0, gitRoot.stderr || gitRoot.stdout);
  cwd = path.normalize(gitRoot.stdout.trim());

  const slug = "repo";
  // Mirror resolveStateDir hash: we write under GROK_CODEX_PLUGIN_STATE directly
  // companion uses resolveStateDir(cwd) → stateRoot/slug-hash
  // Easier: set GROK_CODEX_PLUGIN_STATE and compute path via companion? 
  // Use jobs helpers instead.
  process.env.GROK_CODEX_PLUGIN_STATE = stateRoot;
  delete process.env.CODEX_PLUGIN_DATA;

  // Dynamic import after env set
  return import("../plugins/grok/scripts/lib/jobs.mjs").then(async (jobs) => {
    const {
      resolveStateDir,
      resolveJobsDir,
      writeJobFile,
      upsertJob,
      readJobFile
    } = jobs;

    const stateDir = resolveStateDir(cwd);
    const jobsDir = resolveJobsDir(cwd);
    fs.mkdirSync(jobsDir, { recursive: true });

    const jobId = "plan-reaper-race";
    const resultFile = path.join(jobsDir, `${jobId}.result.json`);
    const sessionId = "11111111-2222-4333-8444-555555555555";

    // Fake session plan.md where harvest looks
    const { resolveGrokSessionDir } = await import("../plugins/grok/scripts/lib/media.mjs");
    const sessionDir = resolveGrokSessionDir(cwd, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "plan.md"),
      "# Context\n\nUse exponential backoff with jitter on all retries.\n"
    );

    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        stdout: JSON.stringify({
          text: "Entering plan mode and exploring...",
          sessionId,
          stopReason: "EndTurn"
        }),
        stderr: ""
      })
    );

    const job = {
      id: jobId,
      kind: "plan",
      status: "failed",
      title: "plan race",
      prompt: "plan something",
      write: false,
      workspaceRoot: cwd,
      resultFile,
      logFile: path.join(jobsDir, `${jobId}.log`),
      progressFile: path.join(jobsDir, `${jobId}.progress.json`),
      error: "Background Grok process is no longer running",
      summary: "Process exited without writing a result",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(job.logFile, "");
    fs.writeFileSync(job.progressFile, "{}");
    writeJobFile(cwd, job);
    upsertJob(cwd, {
      id: jobId,
      kind: "plan",
      status: "failed",
      title: "plan race",
      error: job.error,
      summary: job.summary
    });

    const run = spawnSync(process.execPath, [COMPANION, "result", jobId, "--json"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GROK_CODEX_PLUGIN_STATE: stateRoot,
        CODEX_PLUGIN_DATA: ""
      },
      maxBuffer: 4 * 1024 * 1024
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const out = JSON.parse(run.stdout);
    assert.equal(out.status, "completed");
    assert.equal(out.exitCode, 0);
    assert.match(String(out.resultText || ""), /exponential backoff/);
    assert.ok(
      (out.artifacts || []).some(
        (a) =>
          (typeof a === "string" && a.includes(path.join('.grok', 'plans'))) ||
          (a.path && a.path.includes(path.join('.grok', 'plans')))
      ),
      `expected .grok/plans artifact, got ${JSON.stringify(out.artifacts)}`
    );

    const stored = readJobFile(cwd, jobId);
    assert.equal(stored.status, "completed");
    assert.equal(stored.error, null);

    delete process.env.GROK_CODEX_PLUGIN_STATE;
    fs.rmSync(root, { recursive: true, force: true });
  });
});
