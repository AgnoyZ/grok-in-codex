import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireWorkspaceLock, releaseWorkspaceLock } from './locks.mjs';

// Separate from execution locks: readers, writers and retention all update the index.
export function withStateLock(stateDir, operation, { timeoutMs = 10000 } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const id = `state-${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let lock;
  while (!lock) {
    try {
      lock = acquireWorkspaceLock(path.join(stateDir, '.state-lock'), stateDir, id, 'state');
    } catch (error) {
      if (!/^Workspace (?:lock|is locked)/.test(error.message)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out updating job state in ${stateDir}: ${error.message}`);
      Atomics.wait(wait, 0, 0, 20);
    }
  }
  try { return operation(); }
  finally { releaseWorkspaceLock(lock, id); }
}

export function renameAtomic(temporary, file, {
  platform = process.platform,
  renameSync = fs.renameSync,
  maxRetries = 10,
  retryDelayMs = 10
} = {}) {
  const retryable = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(temporary, file); }
    catch (error) {
      if (platform !== 'win32' || !retryable.has(error.code) || attempt >= maxRetries) throw error;
      Atomics.wait(wait, 0, 0, retryDelayMs * (attempt + 1));
    }
  }
}

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    renameAtomic(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
