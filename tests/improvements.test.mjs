import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bumpVersion } from '../scripts/bump-version.mjs';
import { resolveMcpCwd, requiresWorkspaceWrite, buildCompanionInvocation, listToolDefinitions } from '../plugins/grok/mcp/server.mjs';
import { acquireWorkspaceLock, transferWorkspaceLock, releaseWorkspaceLock, workspaceLockPath } from '../plugins/grok/scripts/lib/locks.mjs';
import { isSameProcess, getProcessStartTime, terminateProcessTree } from '../plugins/grok/scripts/lib/process.mjs';
import { resolveRescueMode } from '../plugins/grok/scripts/lib/rescue.mjs';
import { cleanupJobs, excludeGrokArtifacts } from '../plugins/grok/scripts/lib/maintenance.mjs';
import { limitResult } from '../plugins/grok/scripts/lib/result-limit.mjs';
import { probeCapabilities } from '../plugins/grok/scripts/lib/capabilities.mjs';
import { buildGrokBackgroundWrapperSource, resolveJobTimeout } from '../plugins/grok/scripts/lib/grok.mjs';
import { resolveJobsDir, writeJobFile, upsertJob } from '../plugins/grok/scripts/lib/jobs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = path.join(root, 'plugins/grok');
const versionFiles = ['package.json', 'plugins/grok/.codex-plugin/plugin.json', '.agents/plugins/marketplace.json'];
function versions(dir) {
  const docs = versionFiles.map(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  return [docs[0].version, docs[1].version, docs[2].version, docs[2].plugins.find(p => p.name === 'grok').version];
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-improvements-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('T2 all release version fields are consistent', () => {
  assert.equal(new Set(versions(root)).size, 1);
});
test('T2 bump repairs version drift and rejects invalid versions without mutation', t => {
  const dir = temp(t);
  for (const file of versionFiles) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const file = path.join(dir, versionFiles[1]);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.version = '9.9.9';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => assert.equal(new Set(versions(dir)).size, 1));
  bumpVersion('0.7.0', dir);
  assert.deepEqual(versions(dir), Array(4).fill('0.7.0'));
  assert.throws(() => bumpVersion('bad', dir));
  assert.deepEqual(versions(dir), Array(4).fill('0.7.0'));
});
test('T3 missing cwd in plugin is refused for every write tool; read-only calls retain fallback', t => {
  const cwd = temp(t);
  for (const name of ['grok_rescue', 'grok_implement', 'grok_execute_plan', 'grok_document', 'grok_media', 'grok_babysit']) {
    const options = name === 'grok_media' ? { kind: 'image' } : { action: 'check' };
    assert.throws(() => resolveMcpCwd(options, name, plugin), /project directory as cwd/);
    assert.equal(resolveMcpCwd({ ...options, cwd }, name, plugin), cwd);
  }
  for (const [name, input] of [['grok_review', {}], ['grok_rescue', { readOnly: true }], ['grok_babysit', { action: 'list' }], ['grok_execute_plan', { dryRun: true }]]) {
    assert.equal(resolveMcpCwd(input, name, plugin), plugin);
    assert.equal(requiresWorkspaceWrite(name, input), false);
  }
  assert.throws(() => resolveMcpCwd({ kind: 'image', cwd: path.join(cwd, 'missing') }, 'grok_media'), /does not exist/);
  assert.throws(() => resolveMcpCwd({ kind: 'image', cwd: path.join(root, 'package.json') }, 'grok_media'), /not a directory/);
});
test('T4 same workspace rejects a second writer; separate workspace and read-only calls coexist', t => {
  const dir = temp(t);
  const state = path.join(dir, 'state');
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const lock = acquireWorkspaceLock(state, a, 'writer-a');
  assert.throws(() => acquireWorkspaceLock(state, a, 'writer-b'), /writer-a/);
  const blocked = spawnSync(process.execPath, [path.join(plugin, 'scripts/grok-companion.mjs'), 'task', '--background', '--write', '--json', 'second writer'], {
    cwd: a, encoding: 'utf8', env: { ...process.env, GROK_CODEX_PLUGIN_STATE: state }
  });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(blocked.signal, null, 'lock conflict must not terminate the launcher itself');
  assert.match(blocked.stderr, /writer-a/);
  const other = acquireWorkspaceLock(state, b, 'writer-b');
  assert.equal(resolveMcpCwd({ cwd: a }, 'grok_review'), a);
  releaseWorkspaceLock(lock, 'unrelated');
  assert.ok(fs.existsSync(lock));
  releaseWorkspaceLock(lock, 'writer-a');
  releaseWorkspaceLock(other, 'writer-b');
  assert.ok(!fs.existsSync(lock));
});
test('T4 dead workspace lock is reclaimed', t => {
  const dir = temp(t), state = path.join(dir, 'state');
  const file = workspaceLockPath(state, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ jobId: 'dead', pid: 2147483647 }));
  acquireWorkspaceLock(state, dir, 'replacement');
  assert.equal(JSON.parse(fs.readFileSync(file)).jobId, 'replacement');
  releaseWorkspaceLock(file, 'replacement');
});
test('T5 rescue default, explicit false, read-only, named worktree and environment precedence', () => {
  assert.deepEqual(resolveRescueMode({}, {}), { mode: 'worktree', worktree: true });
  assert.equal(resolveRescueMode({}, { GROK_RESCUE_DEFAULT_WRITE: '1' }).mode, 'direct');
  for (const env of [{}, { GROK_RESCUE_DEFAULT_WRITE: '1' }]) {
    assert.equal(resolveRescueMode({ 'read-only': true, worktree: true }, env).mode, 'readOnly');
    assert.equal(resolveRescueMode({ 'read-only': false }, env).mode, 'direct');
    assert.equal(resolveRescueMode({ worktree: false }, env).mode, 'direct');
    assert.equal(resolveRescueMode({ worktree: true }, env).mode, 'worktree');
    assert.equal(resolveRescueMode({ 'worktree-name': 'isolated' }, env).worktree, 'isolated');
  }
  assert.ok(buildCompanionInvocation('grok_rescue', { prompt: 'x', worktree: false }).args.includes('--worktree=false'));
  assert.ok(buildCompanionInvocation('grok_rescue', { prompt: 'x', readOnly: false }).args.includes('--read-only=false'));
});
test('T6 reused PID fails identity check; legacy jobs and unavailable identity keep PID behavior', () => {
  const probe = { alive: () => true, startTime: () => 'new-start' };
  assert.equal(isSameProcess(123, 'old-start', probe), false);
  assert.equal(isSameProcess(123, 'new-start', probe), true);
  assert.equal(isSameProcess(123, undefined, probe), true);
  assert.equal(isSameProcess(123, 'old-start', { ...probe, startTime: () => null }), true);
  assert.equal(isSameProcess(123, undefined, { ...probe, alive: () => false }), false);
  if (process.platform !== 'win32') assert.ok(getProcessStartTime(process.pid));
});
function seedJob(root, id, status, time) {
  const dir = path.join(root, 'workspace', 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, JSON.stringify({ id, status, finishedAt: new Date(time).toISOString() }));
  return file;
}
test('T7 retention expires finished jobs, caps recent jobs, preserves running jobs and throttles', t => {
  const dir = temp(t), now = Date.now();
  const old = seedJob(dir, 'old', 'completed', now - 31 * 86400000);
  const newest = seedJob(dir, 'newest', 'failed', now);
  const excess = seedJob(dir, 'excess', 'cancelled', now - 100);
  const active = seedJob(dir, 'active', 'running', now - 90 * 86400000);
  const env = { GROK_JOB_RETENTION_MAX: '1' };
  assert.equal(cleanupJobs(dir, { now, env }).removed, 2);
  assert.ok(!fs.existsSync(old)); assert.ok(!fs.existsSync(excess));
  assert.ok(fs.existsSync(newest)); assert.ok(fs.existsSync(active));
  seedJob(dir, 'later', 'completed', now - 40 * 86400000);
  assert.equal(cleanupJobs(dir, { now: now + 100, env }).throttled, true);
  assert.equal(cleanupJobs(dir, { now: now + 86400001, env }).removed, 1);
});
test('T7 live lock protects terminal metadata and project artifacts are untouched', t => {
  const dir = temp(t), state = path.join(dir, 'state'), now = Date.now();
  const file = seedJob(state, 'held', 'failed', now - 90 * 86400000);
  const artifact = path.join(dir, '.grok-docs'); fs.mkdirSync(artifact);
  const lock = acquireWorkspaceLock(state, dir, 'held');
  assert.equal(cleanupJobs(state, { now }).removed, 0);
  assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(lock)); assert.ok(fs.existsSync(artifact));
  releaseWorkspaceLock(lock, 'held');
});
test('T8 timeout precedence, zero and schema forwarding', () => {
  assert.equal(resolveJobTimeout(undefined, {}), 60);
  assert.equal(resolveJobTimeout(undefined, { GROK_JOB_TIMEOUT_MINUTES: '2' }), 2);
  assert.equal(resolveJobTimeout(0, { GROK_JOB_TIMEOUT_MINUTES: '2' }), 0);
  assert.throws(() => resolveJobTimeout(-1)); assert.throws(() => resolveJobTimeout('NaN'));
  for (const tool of listToolDefinitions().filter(t => t.inputSchema.properties.background)) {
    assert.ok(tool.inputSchema.properties.timeoutMinutes, tool.name);
  }
  assert.ok(buildCompanionInvocation('grok_media', { kind: 'image', prompt: 'x', timeoutMinutes: 0 }).args.includes('--timeout-minutes'));
});
test('T8 mock hanging background process times out, retains partial output, releases write lock and reconciles failed', { timeout: 15000 }, async t => {
  const dir = temp(t), state = path.join(dir, 'state');
  const previous = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previous; });
  const id = 'task-timeout';
  const jobsDir = resolveJobsDir(dir); fs.mkdirSync(jobsDir, { recursive: true });
  const resultFile = path.join(jobsDir, id + '.result.json');
  const lockFile = acquireWorkspaceLock(state, dir, id);
  const source = buildGrokBackgroundWrapperSource({
    binary: process.execPath, args: ['-e', "console.log('partial output'); setInterval(() => {}, 1000)"],
    cwd: dir, resultFile, lockFile, jobId: id, timeoutMinutes: 0.005
  });
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  transferWorkspaceLock(lockFile, id, child.pid);
  writeJobFile(dir, { id, kind: 'task', status: 'running', resultFile, lockFile, pid: child.pid, pidStartTime: getProcessStartTime(child.pid), workspaceRoot: dir });
  upsertJob(dir, { id, kind: 'task', status: 'running', resultFile, pid: child.pid });
  const [code] = await exited;
  assert.equal(code, 1, stderr);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.timedOut, true); assert.match(result.stdout, /partial output/); assert.match(result.stderr, /timeout/);
  assert.ok(!fs.existsSync(lockFile));
  const read = spawnSync(process.execPath, [path.join(plugin, 'scripts/grok-companion.mjs'), 'result', id, '--json'], { cwd: dir, env: process.env, encoding: 'utf8' });
  assert.equal(read.status, 1, read.stderr);
  const job = JSON.parse(read.stdout); assert.equal(job.status, 'failed'); assert.match(job.error, /timeout/); assert.match(job.resultText, /partial output/);
});
test('T9 result limit retains full body and artifact paths, supports zero and rejects invalid caps', t => {
  const file = path.join(temp(t), 'output.txt');
  const result = limitResult('abcdef', 3, { outputFile: file, artifacts: ['plan.md'] });
  assert.equal(result.text, 'abc'); assert.equal(result.totalChars, 6); assert.equal(result.truncated, true);
  assert.deepEqual(result.artifactPaths, ['plan.md']); assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  assert.equal(limitResult('abcdef', 0).text, 'abcdef');
  assert.equal(limitResult('abc', 3).truncated, false);
  assert.throws(() => limitResult('abc', -1));
});
test('T10 artifact exclude is idempotent and non-Git directories are skipped', t => {
  const dir = temp(t);
  assert.equal(excludeGrokArtifacts(dir).skipped, true);
  assert.equal(spawnSync('git', ['init'], { cwd: dir }).status, 0);
  const excludeFile = path.join(dir, '.git', 'info', 'exclude');
  fs.appendFileSync(excludeFile, '\n.grok-*/\n'); // Upgrade an already configured repository.
  const first = excludeGrokArtifacts(dir); assert.equal(first.updated, true);
  assert.equal(excludeGrokArtifacts(dir).updated, false);
  assert.equal(fs.readFileSync(first.path, 'utf8').split('.grok-*/').length, 2);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')));
  for (const kind of ['plans', 'designs', 'workflows', 'docs', 'reviews', 'media']) {
    const artifactDir = path.join(dir, '.grok', kind);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'artifact.txt'), 'output');
    assert.equal(spawnSync('git', ['check-ignore', '-q', `.grok/${kind}/artifact.txt`], { cwd: dir }).status, 0);
  }
  fs.writeFileSync(path.join(dir, '.grok', 'settings.json'), '{}');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.grok/settings.json'], { cwd: dir }).status, 1);
});

test('T9 companion bounds JSON and Markdown bodies while keeping the stored job intact', t => {
  const dir = temp(t), state = path.join(dir, 'state');
  const previous = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previous; });
  const id = 'large-result', body = 'x'.repeat(30000), artifact = path.join(dir, 'plan.md');
  writeJobFile(dir, { id, status: 'completed', kind: 'task', resultText: body, artifacts: [artifact] });
  upsertJob(dir, { id, status: 'completed' });
  const run = (...args) => spawnSync(process.execPath, [path.join(plugin, 'scripts/grok-companion.mjs'), 'result', id, ...args], { cwd: dir, encoding: 'utf8', env: process.env });
  const truncated = run('--json'); assert.equal(truncated.status, 0, truncated.stderr);
  const result = JSON.parse(truncated.stdout);
  assert.equal(result.resultText.length, 20000); assert.equal(result.totalChars, body.length);
  assert.equal(result.truncated, true); assert.deepEqual(result.artifactPaths, [artifact]);
  assert.equal(fs.readFileSync(result.fullOutputPath, 'utf8'), body);
  const full = JSON.parse(run('--json', '--max-chars', '0').stdout);
  assert.equal(full.resultText, body); assert.equal(full.truncated, false);
  const markdown = run('--max-chars', '32'); assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /truncated: true/); assert.match(markdown.stdout, /Full output:/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(resolveJobsDir(dir), id + '.json'), 'utf8')).resultText, body);
});
test('T11 capability probes distinguish supported, unsupported and unknown mock help', () => {
  const mock = (text, code = 0) => () => spawnSync(process.execPath, ['-e', `console.log(${JSON.stringify(text)}); process.exit(${code})`], { encoding: 'utf8' });
  const caps = probeCapabilities('mock', mock('Usage: grok\nOptions:\n --worktree --cwd --output-format'));
  assert.equal(caps['--worktree'], 'supported'); assert.equal(caps['--sandbox'], 'unsupported');
  assert.equal(probeCapabilities('mock', mock('unavailable', 1))['--worktree'], 'unknown');
  assert.equal(probeCapabilities('mock', mock('some help'))['--cwd'], 'unknown');
  assert.equal(probeCapabilities(null)['--cwd'], 'unknown');
});

test('T4 writer worker blocks another process, permits read-only work, and releases after completion', { timeout: 15000 }, async t => {
  const dir = temp(t), state = path.join(dir, 'state'), id = 'writer';
  const lockFile = acquireWorkspaceLock(state, dir, id);
  const ready = path.join(dir, 'ready');
  const source = buildGrokBackgroundWrapperSource({
    binary: process.execPath,
    args: ['-e', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(dir, 'finish'))})) { clearInterval(timer); console.log('done'); } }, 10);`],
    cwd: dir, resultFile: path.join(dir, 'writer.result.json'), lockFile, jobId: id
  });
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) terminateProcessTree(child.pid); });
  transferWorkspaceLock(lockFile, id, child.pid);
  for (let i = 0; i < 500 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready));
  const contender = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireWorkspaceLock } from ${JSON.stringify(new URL('../plugins/grok/scripts/lib/locks.mjs', import.meta.url).href)}; acquireWorkspaceLock(${JSON.stringify(state)}, ${JSON.stringify(dir)}, 'second');`
  ], { encoding: 'utf8' });
  assert.notEqual(contender.status, 0); assert.match(contender.stderr, /locked by job writer/);
  const readOnly = buildGrokBackgroundWrapperSource({ binary: process.execPath, args: ['-e', "console.log('review')"], cwd: dir, resultFile: path.join(dir, 'review.result.json') });
  assert.equal(spawnSync(process.execPath, ['-e', readOnly], { encoding: 'utf8' }).status, 0);
  assert.ok(fs.existsSync(lockFile), 'read-only completion must not release writer lock');
  fs.writeFileSync(path.join(dir, 'finish'), 'done');
  assert.equal((await exited)[0], 0);
  assert.ok(!fs.existsSync(lockFile));
});

test('T4 cancellation terminates a mock worker and frees the workspace lock', { timeout: 15000 }, async t => {
  const dir = temp(t), state = path.join(dir, 'state'), id = 'cancel-worker';
  const previous = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previous; });
  const lockFile = acquireWorkspaceLock(state, dir, id);
  const ready = path.join(dir, 'ready');
  const jobsDir = resolveJobsDir(dir); fs.mkdirSync(jobsDir, { recursive: true });
  const resultFile = path.join(jobsDir, id + '.result.json');
  const source = buildGrokBackgroundWrapperSource({ binary: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`],
    cwd: dir, resultFile, lockFile, jobId: id });
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) terminateProcessTree(child.pid); });
  transferWorkspaceLock(lockFile, id, child.pid);
  writeJobFile(dir, { id, kind: 'task', status: 'running', resultFile, lockFile, pid: child.pid, pidStartTime: getProcessStartTime(child.pid) });
  upsertJob(dir, { id, status: 'running', pid: child.pid });
  for (let i = 0; i < 500 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready));
  const cancel = spawnSync(process.execPath, [path.join(plugin, 'scripts/grok-companion.mjs'), 'cancel', id, '--json'], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.equal(cancel.status, 0, cancel.stderr); assert.equal(JSON.parse(cancel.stdout).cancelled, true);
  await exited;
  const next = acquireWorkspaceLock(state, dir, 'next-writer');
  releaseWorkspaceLock(next, 'next-writer');
  const result = spawnSync(process.execPath, [path.join(plugin, 'scripts/grok-companion.mjs'), 'result', id, '--json'], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.equal(JSON.parse(result.stdout).status, 'cancelled', 'late worker output cannot undo cancellation');
});
