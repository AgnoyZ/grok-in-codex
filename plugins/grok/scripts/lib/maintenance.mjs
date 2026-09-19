import fs from 'node:fs';
import path from 'node:path';
import { isSameProcess, runCommand } from './process.mjs';
import { ARTIFACT_LAYOUT } from './artifact-discovery.mjs';
import { withStateLock, writeJsonAtomic } from './state-store.mjs';

function retentionValue(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) throw new Error('Job retention settings must be non-negative numbers');
  return number;
}

export function cleanupJobs(root, { now = Date.now(), force = false, env = process.env } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const stamp = path.join(root, 'cleanup.json');
  if (!force) {
    try { if (now - JSON.parse(fs.readFileSync(stamp, 'utf8')).at < 86400000) return { removed: 0, throttled: true }; } catch {}
  }
  const days = retentionValue(env.GROK_JOB_RETENTION_DAYS, 30);
  const max = Math.floor(retentionValue(env.GROK_JOB_RETENTION_MAX, 200));
  const guard = path.join(root, 'cleanup.lock');
  let fd;
  try { fd = fs.openSync(guard, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') return { removed: 0, throttled: true };
    throw error;
  }
  try {
    const protectedIds = new Set();
    const locksDir = path.join(root, 'locks');
    if (fs.existsSync(locksDir)) {
      for (const entry of fs.readdirSync(locksDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const lock = JSON.parse(fs.readFileSync(path.join(locksDir, entry.name), 'utf8'));
          if (isSameProcess(lock.pid, lock.pidStartTime)) protectedIds.add(lock.jobId);
        } catch { return { removed: 0, throttled: false, reason: 'Unreadable workspace lock; cleanup deferred' }; }
      }
    }
    const candidates = [];
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory() || workspace.name === 'locks') continue;
      const stateDir = path.join(root, workspace.name);
      const jobsDir = path.join(stateDir, 'jobs');
      if (!fs.existsSync(jobsDir) || fs.lstatSync(jobsDir).isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const job = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), 'utf8'));
          if (!job.id || entry.name !== job.id + '.json' || protectedIds.has(job.id)) continue;
          if (!['completed', 'failed', 'cancelled'].includes(job.status)) continue;
          if (job.pid && isSameProcess(job.pid, job.pidStartTime)) continue;
          const time = Date.parse(job.finishedAt || job.updatedAt || job.createdAt);
          if (Number.isFinite(time)) candidates.push({ job, time, jobsDir, stateDir });
        } catch { /* Unknown/corrupt records are preserved. */ }
      }
    }
    candidates.sort((a, b) => b.time - a.time);
    const removedByState = new Map();
    let removed = 0;
    for (const [index, item] of candidates.entries()) {
      if (index < max && now - item.time <= days * 86400000) continue;
      const file = path.join(item.jobsDir, item.job.id + '.json');
      const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!['completed', 'failed', 'cancelled'].includes(latest.status)) continue;
      if (latest.pid && isSameProcess(latest.pid, latest.pidStartTime)) continue;
      // Never follow metadata paths into project artifacts or another workspace.
      for (const suffix of ['.result.json', '.progress.json', '.log', '.pid', '.output.txt', '.json']) {
        const target = path.join(item.jobsDir, item.job.id + suffix);
        try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!removedByState.has(item.stateDir)) removedByState.set(item.stateDir, new Set());
      removedByState.get(item.stateDir).add(item.job.id);
      removed++;
    }
    for (const [stateDir, ids] of removedByState) {
      const file = path.join(stateDir, 'state.json');
      if (!fs.existsSync(file)) continue;
      withStateLock(stateDir, () => {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        state.jobs = (state.jobs || []).filter(job => !ids.has(job.id));
        writeJsonAtomic(file, state);
      });
    }
    fs.writeFileSync(stamp, JSON.stringify({ at: now }));
    return { removed, throttled: false };
  } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}

export function excludeGrokArtifacts(cwd) {
  const result = runCommand('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd });
  if (result.status !== 0) return { updated: false, skipped: true };
  const file = path.resolve(cwd, result.stdout.trim());
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const patterns = ['.grok-*/', ...ARTIFACT_LAYOUT.map(item => `/${item.unified}/`)];
  const lines = new Set(existing.split(/\r?\n/));
  const missing = patterns.filter(pattern => !lines.has(pattern));
  if (!missing.length) return { updated: false, path: file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  return { updated: true, path: file };
}
