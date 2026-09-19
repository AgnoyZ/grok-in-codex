import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProcessStartTime, isSameProcess } from './process.mjs';

export function workspaceLockPath(stateRoot, cwd) {
  const canonical = fs.realpathSync.native(cwd);
  return path.join(stateRoot, 'locks', createHash('sha1').update(canonical).digest('hex') + '.json');
}

export function acquireWorkspaceLock(stateRoot, cwd, jobId, mode = 'direct') {
  const file = workspaceLockPath(stateRoot, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { jobId, pid: process.pid, pidStartTime: getProcessStartTime(process.pid), startedAt: new Date().toISOString(), mode };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('Workspace lock is initializing or unreadable: ' + file + '. Retry or inspect the lock.'); }
    if (isSameProcess(owner.pid, owner.pidStartTime)) {
      throw new Error(`Workspace is locked by job ${owner.jobId}. Wait for it or cancel that job.`);
    }
    // Only one contender may reclaim a stale lock. Other contenders retry later.
    const reclaim = file + '.reclaim';
    let guard;
    try { guard = fs.openSync(reclaim, 'wx'); }
    catch { throw new Error(`Workspace lock for job ${owner.jobId} is being reclaimed. Retry; inspect ${reclaim} if persistent.`); }
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.jobId === owner.jobId && !isSameProcess(current.pid, current.pidStartTime)) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { fs.closeSync(guard); fs.unlinkSync(reclaim); }
  }
  throw new Error('Workspace lock changed repeatedly; retry.');
}

export function transferWorkspaceLock(file, jobId, pid) {
  if (!file) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    const owner = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (owner.jobId !== jobId) throw new Error('Workspace lock ownership changed');
    const data = JSON.stringify({ ...owner, pid, pidStartTime: getProcessStartTime(pid) });
    fs.writeSync(fd, data, 0, 'utf8');
    fs.ftruncateSync(fd, Buffer.byteLength(data));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function releaseWorkspaceLock(file, jobId) {
  if (!file) return;
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).jobId === jobId) fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
