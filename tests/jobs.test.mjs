import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AmbiguousJobError,
  getLastTaskSessionId,
  hasResultFile,
  isTrustedGrokPluginDataDir,
  listRunningJobs,
  listTaskSessions,
  loadState,
  recordTaskSession,
  refreshJobLiveness,
  resolveJob,
  resolveJobFile,
  resolvePluginStateRoot,
  resolveStateDir,
  saveState,
  shouldAttemptBackgroundFinalize,
  tailLog,
  tryReadResultPayload,
  upsertJob,
  writeJobFile
} from "../plugins/grok/scripts/lib/jobs.mjs";

function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-jobs-"));
  // Path must include "grok" so CODEX_PLUGIN_DATA is trusted for this plugin only.
  const pluginData = path.join(root, "grok-plugin-data");
  fs.mkdirSync(pluginData, { recursive: true });
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const prev = process.env.CODEX_PLUGIN_DATA;
  const prevGrok = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.CODEX_PLUGIN_DATA = pluginData;
  delete process.env.GROK_CODEX_PLUGIN_STATE;
  try {
    return fn(cwd, pluginData);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_PLUGIN_DATA;
    } else {
      process.env.CODEX_PLUGIN_DATA = prev;
    }
    if (prevGrok === undefined) {
      delete process.env.GROK_CODEX_PLUGIN_STATE;
    } else {
      process.env.GROK_CODEX_PLUGIN_STATE = prevGrok;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("isTrustedGrokPluginDataDir rejects other plugins like codex", () => {
  assert.equal(
    isTrustedGrokPluginDataDir("/Users/x/.claude/plugins/data/codex-openai-codex"),
    false
  );
  // Marketplace suffix alone must not trust another plugin from grok-in-claude
  assert.equal(
    isTrustedGrokPluginDataDir("/Users/x/.claude/plugins/data/codex-grok-in-claude"),
    false
  );
  assert.equal(
    isTrustedGrokPluginDataDir("/Users/x/.claude/plugins/data/grok-grok-in-claude"),
    true
  );
  assert.equal(isTrustedGrokPluginDataDir("/tmp/grok-plugin-data/xyz"), true);
});

test("resolvePluginStateRoot ignores foreign CODEX_PLUGIN_DATA", () => {
  const prev = process.env.CODEX_PLUGIN_DATA;
  const prevGrok = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.CODEX_PLUGIN_DATA = "/Users/x/.claude/plugins/data/codex-openai-codex";
  delete process.env.GROK_CODEX_PLUGIN_STATE;
  try {
    const root = resolvePluginStateRoot();
    // Foreign host plugin data is ignored; fall back to Codex-owned state root.
    assert.match(root, /\.grok[/\\]codex-plugin[/\\]state$/);
    assert.ok(!root.includes("codex-openai-codex"));
    assert.ok(!root.includes("claude-plugin"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_PLUGIN_DATA;
    else process.env.CODEX_PLUGIN_DATA = prev;
    if (prevGrok === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE;
    else process.env.GROK_CODEX_PLUGIN_STATE = prevGrok;
  }
});

test("tailLog truncates huge NDJSON status lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-log-"));
  const log = path.join(dir, "j.log");
  const huge = JSON.stringify({
    type: "available_commands",
    tools: Array.from({ length: 200 }, (_, i) => `tool_${i}`)
  });
  fs.writeFileSync(log, `ok line\n${huge}\nfinal\n`);
  const lines = tailLog(log, 12, { maxBytesPerLine: 200 });
  assert.equal(lines[0], "ok line");
  assert.match(lines[1], /truncated/);
  assert.equal(lines[2], "final");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refreshJobLiveness does not reaper-fail when result.json exists", () => {
  withTempWorkspace((cwd) => {
    const jobId = "plan-bg-1";
    const jobsDir = path.join(resolveStateDir(cwd), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const resultFile = path.join(jobsDir, `${jobId}.result.json`);
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        stdout: JSON.stringify({
          text: "Entering plan mode",
          sessionId: "sess-plan",
          stopReason: "EndTurn"
        }),
        stderr: ""
      })
    );
    const job = {
      id: jobId,
      kind: "plan",
      status: "running",
      title: "plan",
      resultFile,
      // dead pid
      pid: 999999999
    };
    writeJobFile(cwd, job);
    upsertJob(cwd, job);
    const refreshed = refreshJobLiveness(cwd, job);
    assert.equal(refreshed.status, "running");
    assert.equal(refreshed.alive, false);
    assert.equal(refreshed.pendingResult, true);
    assert.equal(hasResultFile(refreshed), true);
  });
});

test("shouldAttemptBackgroundFinalize recovers reaper false-failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-res-"));
  const resultFile = path.join(tmp, "j.result.json");
  fs.writeFileSync(resultFile, JSON.stringify({ exitCode: 0, stdout: "{}" }));
  assert.equal(
    shouldAttemptBackgroundFinalize({
      status: "failed",
      error: "Background Grok process is no longer running",
      resultFile
    }),
    true
  );
  assert.equal(
    shouldAttemptBackgroundFinalize({
      status: "failed",
      error: "Grok failed for real",
      exitCode: 1,
      resultText: "err",
      resultFile
    }),
    false
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("tryReadResultPayload rejects truncated/corrupt files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-corrupt-"));
  const good = path.join(tmp, "good.json");
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(good, JSON.stringify({ exitCode: 0, stdout: "hi", stderr: "" }));
  fs.writeFileSync(bad, '{"exitCode":0,"stdout":'); // truncated
  assert.equal(tryReadResultPayload(good).ok, true);
  assert.equal(tryReadResultPayload(bad).ok, false);
  assert.equal(tryReadResultPayload(bad).reason, "unparseable");
  assert.equal(tryReadResultPayload(path.join(tmp, "missing.json")).reason, "missing");
  // incomplete: missing stdout key
  const incomplete = path.join(tmp, "incomplete.json");
  fs.writeFileSync(incomplete, JSON.stringify({ exitCode: 0 }));
  assert.equal(tryReadResultPayload(incomplete).reason, "incomplete");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("refreshJobLiveness fails (not zombies) on corrupt result.json when pid dead", () => {
  withTempWorkspace((cwd) => {
    const jobId = "plan-zombie";
    const jobsDir = path.join(resolveStateDir(cwd), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const resultFile = path.join(jobsDir, `${jobId}.result.json`);
    fs.writeFileSync(resultFile, '{"exitCode":0,"stdout":'); // truncated mid-write
    const job = {
      id: jobId,
      kind: "plan",
      status: "running",
      title: "zombie",
      resultFile,
      pid: 999999999
    };
    writeJobFile(cwd, job);
    upsertJob(cwd, job);
    const refreshed = refreshJobLiveness(cwd, job);
    assert.equal(refreshed.status, "failed");
    assert.match(String(refreshed.error || ""), /corrupt|unparseable|incomplete/i);
    assert.equal(hasResultFile(refreshed), false);
  });
});

test("recordTaskSession keeps multi-session history and latest pointer", () => {
  withTempWorkspace((cwd) => {
    recordTaskSession(cwd, {
      sessionId: "sess-a",
      jobId: "task-1",
      title: "first",
      kind: "task"
    });
    recordTaskSession(cwd, {
      sessionId: "sess-b",
      jobId: "task-2",
      title: "second",
      kind: "task"
    });

    assert.equal(getLastTaskSessionId(cwd), "sess-b");
    const sessions = listTaskSessions(cwd);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, "sess-b");
    assert.equal(sessions[1].sessionId, "sess-a");
    assert.equal(sessions[0].jobId, "task-2");
  });
});

test("recordTaskSession dedupes by sessionId", () => {
  withTempWorkspace((cwd) => {
    recordTaskSession(cwd, { sessionId: "sess-a", jobId: "task-1", title: "old" });
    recordTaskSession(cwd, { sessionId: "sess-a", jobId: "task-9", title: "new" });
    const sessions = listTaskSessions(cwd);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].jobId, "task-9");
    assert.equal(sessions[0].title, "new");
  });
});

test("resolveJob requires id when multiple jobs are running", () => {
  withTempWorkspace((cwd) => {
    upsertJob(cwd, { id: "job-a", kind: "task", status: "running", title: "A" });
    upsertJob(cwd, { id: "job-b", kind: "review", status: "running", title: "B" });
    // Mark as not alive via dead pid so refresh doesn't flip them failed without pid files —
    // write job files as running without live pids; refreshJobLiveness will mark failed.
    // Instead keep status completed for one path: listRunningJobs uses status===running after refresh.
    // Force-write job files that stay "running" by using a fake alive pid of current process.
    const selfPid = process.pid;
    upsertJob(cwd, { id: "job-a", kind: "task", status: "running", title: "A", pid: selfPid });
    upsertJob(cwd, { id: "job-b", kind: "review", status: "running", title: "B", pid: selfPid });

    const running = listRunningJobs(cwd);
    assert.ok(running.length >= 2);

    assert.throws(() => resolveJob(cwd, null), (err) => {
      assert.ok(err instanceof AmbiguousJobError);
      assert.ok(err.running.length >= 2);
      return true;
    });

    const picked = resolveJob(cwd, "job-a");
    assert.equal(picked.id, "job-a");
  });
});

test("resolveJob finds an explicit job id across workspace state partitions", () => {
  withTempWorkspace((cwd) => {
    const other = path.join(path.dirname(cwd), "other-repo");
    fs.mkdirSync(other, { recursive: true });
    const job = {
      id: "task-cross-workspace",
      kind: "task",
      status: "running",
      title: "cross workspace",
      pid: process.pid,
      workspaceRoot: cwd
    };
    writeJobFile(cwd, job);
    upsertJob(cwd, job);

    const resolved = resolveJob(other, job.id);

    assert.equal(resolved.id, job.id);
    assert.equal(resolved.workspaceRoot, cwd);
    assert.equal(resolved.status, "running");
  });
});

test("loadState migrates v2 lastTaskSessionId into listTaskSessions", () => {
  withTempWorkspace((cwd) => {
    saveState(cwd, {
      version: 2,
      lastTaskSessionId: "legacy-sess",
      taskSessions: [],
      config: { stopReviewGate: false },
      jobs: []
    });
    const sessions = listTaskSessions(cwd);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "legacy-sess");
    const state = loadState(cwd);
    assert.equal(state.lastTaskSessionId, "legacy-sess");
  });
});
