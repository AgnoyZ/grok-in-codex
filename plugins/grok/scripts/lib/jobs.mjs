import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSameProcess, readPidFile } from "./process.mjs";
import { releaseWorkspaceLock } from './locks.mjs';
import { withStateLock, writeJsonAtomic } from './state-store.mjs';
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 3;
const PLUGIN_DATA_ENV = "CODEX_PLUGIN_DATA";
const GROK_STATE_ENV = "GROK_CODEX_PLUGIN_STATE";
const FALLBACK_STATE_ROOT = path.join(os.homedir(), ".grok", "codex-plugin", "state");
const MAX_JOBS = 200;
const MAX_TASK_SESSIONS = 20;

/**
 * Only trust CODEX_PLUGIN_DATA when it clearly belongs to *this* grok plugin.
 * Host data dirs are often `<plugin>-<marketplace>`. Matching a marketplace
 * substring alone can trust foreign plugins, so we match the **plugin segment**
 * (basename starts with `grok-` or is `grok`). Claude state uses a separate
 * env (`GROK_CLAUDE_PLUGIN_STATE` / `claude-plugin` fallback) and is never
 * read here — Codex only honors `GROK_CODEX_PLUGIN_STATE` / `CODEX_PLUGIN_DATA`.
 */
export function isTrustedGrokPluginDataDir(dir) {
  if (!dir) {
    return false;
  }
  const n = String(dir).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const base = n.split("/").pop() || "";
  // Plugin id is the first hyphen segment(s) before marketplace suffix is hard;
  // require basename to start with "grok-" or equal "grok".
  if (base === "grok" || base.startsWith("grok-")) {
    return true;
  }
  // Explicit test / override path markers
  if (n.includes("grok-plugin-data") || /\/grok-jobs-[^/]+\/grok-plugin-data$/.test(n)) {
    return true;
  }
  return false;
}

/**
 * Read and validate a background result.json written by spawnGrokBackground.
 * Requires parseable JSON with exitCode + stdout (complete wrapper payload).
 * Partial/truncated files (mid-write kill, ENOSPC) return ok:false so the reaper
 * can fail the job instead of leaving it "running" forever.
 */
export function tryReadResultPayload(resultFile) {
  if (!resultFile || !fs.existsSync(resultFile)) {
    return { ok: false, reason: "missing", payload: null };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(resultFile, "utf8");
  } catch {
    return { ok: false, reason: "unreadable", payload: null };
  }
  if (!String(raw).trim()) {
    return { ok: false, reason: "empty", payload: null };
  }
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "invalid", payload: null };
    }
    // Wrapper always writes these; absence ⇒ incomplete/corrupt write
    if (!Object.prototype.hasOwnProperty.call(payload, "exitCode")) {
      return { ok: false, reason: "incomplete", payload: null };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "stdout")) {
      return { ok: false, reason: "incomplete", payload: null };
    }
    return { ok: true, reason: null, payload };
  } catch {
    return { ok: false, reason: "unparseable", payload: null };
  }
}

/** True when a complete, parseable result.json is available for reconcile. */
export function hasResultFile(job) {
  return tryReadResultPayload(job?.resultFile).ok;
}

/**
 * Whether maybeFinalizeBackgroundJob should try to reconcile result.json.
 * Includes reaper false-failures so a good result is not permanently lost.
 */
export function shouldAttemptBackgroundFinalize(job) {
  if (!job || !hasResultFile(job)) {
    return false;
  }
  if (job.status === "running") {
    return true;
  }
  if (job.status === "failed") {
    // Reaper race: pid gone before finalize, marked failed while result.json is good
    if (job.error === "Background Grok process is no longer running") {
      return true;
    }
    if (job.summary === "Process exited without writing a result") {
      return true;
    }
    // Never fully reconciled from result.json
    if (job.exitCode == null && !job.resultText) {
      return true;
    }
  }
  return false;
}

export function resolvePluginStateRoot() {
  if (process.env[GROK_STATE_ENV]) {
    return process.env[GROK_STATE_ENV];
  }
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir && isTrustedGrokPluginDataDir(pluginDataDir)) {
    return path.join(pluginDataDir, "state");
  }
  return FALLBACK_STATE_ROOT;
}

export function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    lastTaskSessionId: null,
    taskSessions: [],
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const stateRoot = resolvePluginStateRoot();
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobPidFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.pid`);
}

export function resolveJobProgressFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.progress.json`);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      taskSessions: Array.isArray(parsed.taskSessions) ? parsed.taskSessions : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    throw new Error(`Cannot read job state ${stateFile}: ${error.message}`);
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const retained = new Set(sorted.filter(job => job.status !== 'running').slice(0, MAX_JOBS));
  return sorted.filter(job => job.status === 'running' || retained.has(job));
}

function pruneTaskSessions(sessions) {
  return [...(sessions ?? [])]
    .filter((entry) => entry && entry.sessionId)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_TASK_SESSIONS);
}

export function saveState(cwd, state) {
  return withStateLock(resolveStateDir(cwd), () => saveStateUnlocked(cwd, state));
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  const next = {
    version: STATE_VERSION,
    lastTaskSessionId: state.lastTaskSessionId ?? null,
    taskSessions: pruneTaskSessions(state.taskSessions ?? []),
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: pruneJobs(state.jobs ?? [])
  };
  writeJsonAtomic(resolveStateFile(cwd), next);
  return next;
}

export function updateState(cwd, mutate) {
  return withStateLock(resolveStateDir(cwd), () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, patch) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      ...patch
    };
  }).config;
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (index === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[index] = {
      ...state.jobs[index],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function writeJobFile(cwd, job) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, job.id);
  writeJsonAtomic(filePath, job);
  return filePath;
}

export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record a finished task/rescue session for multi-session resume.
 * Keeps lastTaskSessionId as the latest (backward compatible).
 */
export function recordTaskSession(cwd, { sessionId, jobId = null, title = null, kind = "task" } = {}) {
  if (!sessionId) {
    return;
  }
  updateState(cwd, (state) => {
    state.lastTaskSessionId = sessionId;
    const entry = {
      sessionId,
      jobId,
      title,
      kind,
      updatedAt: nowIso()
    };
    const existing = Array.isArray(state.taskSessions) ? state.taskSessions : [];
    state.taskSessions = [entry, ...existing.filter((s) => s.sessionId !== sessionId)];
  });
}

/** @deprecated Prefer recordTaskSession — kept for call sites that only have a session id. */
export function setLastTaskSessionId(cwd, sessionId) {
  recordTaskSession(cwd, { sessionId });
}

export function getLastTaskSessionId(cwd) {
  const state = loadState(cwd);
  if (state.lastTaskSessionId) {
    return state.lastTaskSessionId;
  }
  const sessions = listTaskSessions(cwd);
  return sessions[0]?.sessionId ?? null;
}

export function listTaskSessions(cwd) {
  const state = loadState(cwd);
  const sessions = pruneTaskSessions(state.taskSessions ?? []);
  if (sessions.length) {
    return sessions;
  }
  // Migrate v2 state that only had lastTaskSessionId
  if (state.lastTaskSessionId) {
    return [
      {
        sessionId: state.lastTaskSessionId,
        jobId: null,
        title: null,
        kind: "task",
        updatedAt: null
      }
    ];
  }
  return [];
}

export function readJobProgress(cwd, jobId) {
  const filePath = resolveJobProgressFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Tail a job log. Truncates huge NDJSON status lines (e.g. available_commands dumps)
 * so status output stays readable.
 */
export function tailLog(filePath, maxLines = 12, { maxBytesPerLine = 480 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => {
        const bytes = Buffer.byteLength(line, "utf8");
        if (bytes <= maxBytesPerLine) {
          return line;
        }
        if (
          /available_commands|"tools"\s*:|"slash_commands"|stream_event/i.test(line)
        ) {
          return `[truncated ${bytes}-byte status/NDJSON line]`;
        }
        // Keep head of line for context
        let cut = line.slice(0, maxBytesPerLine);
        while (Buffer.byteLength(cut, "utf8") > maxBytesPerLine && cut.length > 0) {
          cut = cut.slice(0, -1);
        }
        return `${cut}…`;
      });
  } catch {
    return [];
  }
}

export function refreshJobLiveness(cwd, job) {
  if (!job || job.status !== "running") {
    return job;
  }

  const pid = job.pid ?? readPidFile(resolveJobPidFile(cwd, job.id));
  const identity = job.pidStartTime ?? readJobFile(cwd, job.id)?.pidStartTime;
  if (pid && isSameProcess(pid, identity)) {
    const progress = readJobProgress(cwd, job.id);
    return { ...job, pid, alive: true, progress };
  }

  const stored = readJobFile(cwd, job.id);
  if (stored && stored.status && stored.status !== "running") {
    upsertJob(cwd, {
      id: job.id,
      status: stored.status,
      finishedAt: stored.finishedAt ?? nowIso(),
      summary: stored.summary ?? job.summary,
      exitCode: stored.exitCode ?? null,
      grokSessionId: stored.grokSessionId ?? job.grokSessionId,
      error: stored.error ?? null
    });
    return { ...job, ...stored, alive: false };
  }

  // Pid gone: only hold "running" when a *complete* result.json is ready to
  // finalize. Truncated/unparseable files must fail (not zombie forever).
  if (job.status === "running") {
    const resultPath = job.resultFile || stored?.resultFile;
    const complete = tryReadResultPayload(resultPath);
    if (complete.ok) {
      return {
        ...job,
        ...(stored || {}),
        status: "running",
        pid: pid ?? job.pid ?? null,
        alive: false,
        pendingResult: true
      };
    }
    const corrupt =
      resultPath &&
      fs.existsSync(resultPath) &&
      !complete.ok &&
      complete.reason !== "missing";
    const finished = {
      ...job,
      status: "failed",
      finishedAt: nowIso(),
      summary: corrupt
        ? "Background Grok result file is corrupt or incomplete"
        : job.summary || "Process exited without writing a result",
      error: corrupt
        ? `Background result.json is ${complete.reason} (process dead)`
        : "Background Grok process is no longer running",
      alive: false
    };
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      finishedAt: finished.finishedAt,
      summary: finished.summary,
      error: finished.error
    });
    writeJobFile(cwd, finished);
    releaseWorkspaceLock(job.lockFile || stored?.lockFile, job.id);
    return finished;
  }

  return { ...job, alive: false };
}

export function listRunningJobs(cwd) {
  return listJobs(cwd)
    .map((job) => refreshJobLiveness(cwd, job))
    .filter((job) => job.status === "running");
}

export class AmbiguousJobError extends Error {
  constructor(running) {
    const ids = running.map((job) => `\`${job.id}\``).join(", ");
    super(
      `Multiple Grok jobs are running (${running.length}). Pass a job id: ${ids}. Use \`/grok:status\` to list them.`
    );
    this.name = "AmbiguousJobError";
    this.running = running;
  }
}

export function resolveJob(cwd, jobId) {
  const jobs = listJobs(cwd).map((job) => refreshJobLiveness(cwd, job));
  if (jobId) {
    const match = jobs.find((job) => job.id === jobId) || readJobFile(cwd, jobId);
    if (!match) {
      throw new Error(`Unknown job id: ${jobId}`);
    }
    return refreshJobLiveness(cwd, match);
  }

  const running = jobs.filter((job) => job.status === "running");
  if (running.length === 1) {
    return running[0];
  }
  if (running.length > 1) {
    throw new AmbiguousJobError(running);
  }
  if (jobs[0]) {
    return jobs[0];
  }
  throw new Error("No Grok jobs found for this repository. Run a /grok command first.");
}
