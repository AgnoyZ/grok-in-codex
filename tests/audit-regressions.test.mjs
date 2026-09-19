import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { loadState, resolveStateFile, resolveStateDir, setConfig, updateState } from '../plugins/grok/scripts/lib/jobs.mjs';
import { withStateLock } from '../plugins/grok/scripts/lib/state-store.mjs';
import { collectDesignArtifacts, collectDocumentArtifacts, extractDesignDocPathFromText, resolveLatestDesignDoc } from '../plugins/grok/scripts/lib/artifacts.mjs';
import { assertBestOfNSupported, runGrok, spawnGrokBackground } from '../plugins/grok/scripts/lib/grok.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}
function env(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}
function worker(source, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { env: process.env, windowsHide: true });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`)));
  });
}
const jobsUrl = new URL('../plugins/grok/scripts/lib/jobs.mjs', import.meta.url).href;
const storeUrl = new URL('../plugins/grok/scripts/lib/state-store.mjs', import.meta.url).href;

test('concurrent state updates retain every job and configuration; readers see complete JSON', async t => {
  const cwd = temporary(t);
  env(t, 'GROK_CODEX_PLUGIN_STATE', path.join(cwd, 'state'));
  setConfig(cwd, { stopReviewGate: true });
  const file = resolveStateFile(cwd);
  const source = `import {updateState} from ${JSON.stringify(jobsUrl)};
    updateState(process.argv[1], state => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
      state.jobs.push({id:process.argv[2],status:'running',summary:'x'.repeat(100000)});
    });`;
  const reader = `import fs from 'node:fs';
    for(let i=0;i<150;i++) { JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }`;
  await Promise.all([worker(reader, [file]), ...Array.from({ length: 4 }, (_, i) => worker(source, [cwd, `job-${i}`]))]);
  assert.deepEqual(loadState(cwd).jobs.map(job => job.id).sort(), ['job-0', 'job-1', 'job-2', 'job-3']);
  assert.equal(loadState(cwd).config.stopReviewGate, true);
});

test('state transaction failures preserve existing data and release the lock', t => {
  const cwd = temporary(t);
  env(t, 'GROK_CODEX_PLUGIN_STATE', path.join(cwd, 'state'));
  setConfig(cwd, { stopReviewGate: true });
  assert.throws(() => updateState(cwd, state => { state.jobs.push({ id: 'discard' }); throw new Error('abort'); }), /abort/);
  assert.deepEqual(loadState(cwd).jobs, []);
  setConfig(cwd, { stopReviewGate: false });
  const file = resolveStateFile(cwd);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => setConfig(cwd, { stopReviewGate: true }), /Cannot read job state/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('state lock recovers dead owners and bounds waits for live owners', async t => {
  const cwd = temporary(t);
  env(t, 'GROK_CODEX_PLUGIN_STATE', path.join(cwd, 'state'));
  const dir = resolveStateDir(cwd);
  await worker(`import {withStateLock} from ${JSON.stringify(storeUrl)};
    withStateLock(process.argv[1], () => process.exit(0));`, [dir]);
  setConfig(cwd, { stopReviewGate: true });
  withStateLock(dir, () => {
    assert.throws(() => withStateLock(dir, () => {}, { timeoutMs: 30 }), /Timed out/);
  });
  assert.equal(loadState(cwd).config.stopReviewGate, true);
});

test('design collection never imports unreported shared scratch or old project documents', t => {
  const root = temporary(t);
  env(t, 'TMPDIR', root);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const shared = path.join(root, `grok-${uid}`);
  fs.mkdirSync(shared);
  const foreign = path.join(shared, 'grok-design-doc-other-project.md');
  fs.writeFileSync(foreign, '# Other project');
  const cwd = path.join(root, 'My Project'); fs.mkdirSync(cwd);
  const previousDir = path.join(cwd, '.grok', 'designs'); fs.mkdirSync(previousDir, { recursive: true });
  const previous = path.join(previousDir, 'old.md'); fs.writeFileSync(previous, '# Old');
  fs.utimesSync(previous, new Date(0), new Date(0));
  assert.deepEqual(collectDesignArtifacts(cwd, { jobId: 'empty' }), []);
  const current = path.join(shared, 'grok-design-doc-current task.md');
  fs.writeFileSync(current, '# Current');
  const artifacts = collectDesignArtifacts(cwd, { jobId: 'current', text: `DESIGN_DOC_PATH="${current}"` });
  assert.equal(artifacts.length, 2);
  const copy = artifacts.find(a => a.kind === 'design-copy');
  assert.equal(fs.readFileSync(copy.path, 'utf8'), '# Current');
  assert.equal(resolveLatestDesignDoc(cwd), copy.path);
  assert.ok(!artifacts.some(a => a.path === foreign || a.path === previous));
  assert.equal(fs.readFileSync(foreign, 'utf8'), '# Other project');
});

test('design path markers preserve spaces, quotes, apostrophes and Windows separators', () => {
  for (const file of ['D:/Projects/My App/design.md', String.raw`D:\Projects\My App\design.md`, "/tmp/John's App/design.md"]) {
    for (const marker of ['DESIGN_DOC_PATH=', 'design document is at: ', 'wrote the design document to: ']) {
      for (const quote of ['', '"', '`']) {
        assert.equal(extractDesignDocPathFromText(marker + quote + file + quote + '\nDone.'), file);
      }
    }
  }
  assert.equal(extractDesignDocPathFromText("DESIGN_DOC_PATH='/tmp/My App/design.md'."), '/tmp/My App/design.md');
  assert.equal(extractDesignDocPathFromText('`DESIGN_DOC_PATH=/tmp/My App/design.md`'), '/tmp/My App/design.md');
});

test('document path markers collect quoted and unquoted paths containing spaces', t => {
  const root = temporary(t);
  const source = path.join(root, 'My Documents'); fs.mkdirSync(source);
  const file = path.join(source, 'report final.pdf'); fs.writeFileSync(file, 'pdf-bytes');
  for (const [index, marker] of [`DOCUMENT_PATH="${file}"`, `DOCUMENT_PATH=${file}`, `Saved to \`${file}\``].entries()) {
    const cwd = path.join(root, `project-${index}`); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'final.pdf'), 'unrelated suffix');
    const artifacts = collectDocumentArtifacts(cwd, { text: marker });
    const copy = artifacts.find(a => a.kind === 'document-copy');
    assert.ok(copy, marker);
    assert.equal(artifacts.length, 2);
    assert.equal(fs.readFileSync(copy.path, 'utf8'), 'pdf-bytes');
  }
});

test('bestOfN preflight supports accepted hidden flags and rejects unsupported or unknown CLI', () => {
  let probes = 0;
  const supported = (binary, args) => {
    probes++;
    assert.deepEqual(args, ['--best-of-n', '3', '--help']);
    return { status: 0, stdout: 'Usage: grok [OPTIONS]' };
  };
  assertBestOfNSupported('grok', {}, supported);
  assertBestOfNSupported('grok', { bestOfN: 1 }, supported);
  assert.equal(probes, 0);
  assertBestOfNSupported('grok', { bestOfN: 3 }, supported);
  assert.equal(probes, 1);
  for (const result of [{ status: 2 }, { status: null }, { status: 0, stdout: 'not help' }]) {
    assert.throws(() => assertBestOfNSupported('grok', { bestOfN: 3 }, () => result), /Remove bestOfN or set it to 1/);
  }
  for (const bestOfN of [0, -1, 1.5, 'invalid']) assert.throws(() => assertBestOfNSupported('grok', { bestOfN }), /positive integer/);
});

test('foreground and background reject unsupported bestOfN before generation', t => {
  env(t, 'GROK_BINARY', process.execPath); // Node rejects --best-of-n, without invoking a model.
  for (const run of [runGrok, spawnGrokBackground]) {
    assert.throws(() => run({ prompt: 'must not run', bestOfN: 2 }), /no generation was started/);
  }
});
