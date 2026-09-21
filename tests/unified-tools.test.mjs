import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCompanionInvocation, listToolDefinitions, resolveMcpCwd, runCompanion } from '../plugins/grok/mcp/server.mjs';
import { discoverArtifacts, previewArtifactMigration, ARTIFACT_LAYOUT } from '../plugins/grok/scripts/lib/artifact-discovery.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-unified-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(cwd, relative, content = 'artifact') {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('removed MCP tools are neither advertised nor callable', () => {
  const names = listToolDefinitions().map(tool => tool.name);
  for (const name of ['grok_status', 'grok_result', 'grok_cancel', 'grok_image', 'grok_video']) {
    assert.ok(!names.includes(name));
    assert.throws(() => buildCompanionInvocation(name, {}), /Unknown Grok tool/);
    assert.throws(() => runCompanion(name, {}), /Unknown Grok tool/);
  }
  for (const name of ['grok_job', 'grok_media', 'grok_artifacts']) assert.ok(names.includes(name));
});

test('grok_job routes all operations and rejects ambiguous destructive inputs', () => {
  assert.deepEqual(buildCompanionInvocation('grok_job', { all: true, json: true }), { command: 'status', args: ['status', '--all', '--json'] });
  assert.deepEqual(buildCompanionInvocation('grok_job', { action: 'result', jobId: 'job-1', maxChars: 0, json: true }), {
    command: 'result', args: ['result', '--max-chars', '0', '--json', 'job-1']
  });
  assert.deepEqual(buildCompanionInvocation('grok_job', { action: 'cancel', jobId: 'job-1' }), { command: 'cancel', args: ['cancel', 'job-1'] });
  for (const jobId of [undefined, '', ' ', null, 12]) assert.throws(() => buildCompanionInvocation('grok_job', { action: 'cancel', jobId }), /explicit jobId/);
  assert.throws(() => buildCompanionInvocation('grok_job', { action: 'delete' }), /action must/);
  assert.throws(() => buildCompanionInvocation('grok_job', { action: 'cancel', jobId: 'x', all: true }), /only supported/);
  assert.throws(() => buildCompanionInvocation('grok_job', { maxChars: 3 }), /only supported/);
});

test('grok_job schema stays explicit for Codex tool generation', () => {
  const tool = listToolDefinitions().find(entry => entry.name === 'grok_job');
  assert.ok(tool.inputSchema.properties.cwd);
  assert.ok(tool.inputSchema.properties.jobId);
  assert.equal(tool.inputSchema.allOf, undefined);
});

test('grok_media forwards both media kinds and enforces workspace and kind-specific arguments', () => {
  const image = buildCompanionInvocation('grok_media', { kind: 'image', edit: 'input.png', out: 'assets', background: true, timeoutMinutes: 2, json: true, prompt: 'edit' });
  assert.deepEqual(image, { command: 'image', args: ['image', '--timeout-minutes', '2', '--background', '--out', 'assets', '--edit', 'input.png', '--json', 'edit'] });
  const video = buildCompanionInvocation('grok_media', { kind: 'video', image: 'input.png', refs: ['a.png', 'b.png'], duration: '6', aspect: '16:9' });
  assert.deepEqual(video.args, ['video', '--aspect', '16:9', '--image', 'input.png', '--duration', '6', '--ref', 'a.png', '--ref', 'b.png']);
  for (const input of [{}, { kind: 'pdf' }, { kind: 'video', edit: 'x' }, { kind: 'image', refs: [] }]) {
    assert.throws(() => buildCompanionInvocation('grok_media', input));
  }
  const plugin = path.resolve('plugins/grok');
  for (const kind of ['image', 'video']) assert.throws(() => resolveMcpCwd({ kind }, 'grok_media', plugin), /project directory/);
});

test('artifact discovery inventories both layouts, preserves nesting and does not create directories', t => {
  const cwd = workspace(t);
  for (const item of ARTIFACT_LAYOUT) write(cwd, `${item.legacy}/nested/a.txt`);
  write(cwd, '.grok/plans/new.md');
  write(cwd, '.grok/settings.json', 'unrelated config');
  const report = discoverArtifacts(cwd);
  assert.equal(report.files.length, 7);
  assert.equal(report.complete, true);
  assert.equal(report.files.filter(file => file.layout === 'unified').length, 1);
  const preview = previewArtifactMigration(cwd);
  assert.equal(preview.summary.ready, 6);
  assert.equal(preview.executionSupported, false);
  assert.ok(preview.operations.some(op => op.target === path.join(fs.realpathSync(cwd), '.grok/media/nested/a.txt')));
  assert.ok(!fs.existsSync(path.join(cwd, '.grok/media')));
  const empty = workspace(t);
  assert.deepEqual(discoverArtifacts(empty).files, []);
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('artifact preview reports existing files and blocked parents without overwriting', t => {
  const cwd = workspace(t);
  write(cwd, '.grok-plans/plan.md', 'legacy');
  write(cwd, '.grok/plans/plan.md', 'different');
  write(cwd, '.grok-docs/nested/deck.pptx');
  write(cwd, '.grok/docs/nested', 'parent is a file');
  const report = previewArtifactMigration(cwd);
  assert.equal(report.summary.conflicts, 2);
  assert.ok(report.operations.some(op => op.reason === 'target-exists'));
  assert.ok(report.operations.some(op => op.reason === 'parent-not-directory'));
  assert.equal(fs.readFileSync(path.join(cwd, '.grok/plans/plan.md'), 'utf8'), 'different');
  assert.equal(fs.readFileSync(path.join(cwd, '.grok-plans/plan.md'), 'utf8'), 'legacy');
});

test('artifact scanning never follows source or target directory links', t => {
  const cwd = workspace(t), outside = workspace(t);
  write(outside, 'secret.txt');
  fs.symlinkSync(outside, path.join(cwd, '.grok-plans'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(cwd, '.grok'), process.platform === 'win32' ? 'junction' : 'dir');
  write(cwd, '.grok-media/image/a.png');
  const report = previewArtifactMigration(cwd);
  assert.equal(report.files.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.operations[0].status, 'conflict');
  assert.equal(report.operations[0].reason, 'symbolic-link');
  assert.ok(report.warnings.some(item => item.reason === 'symbolic-link'));
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
});

test('artifact scan bounds explicitly report incomplete inventories', t => {
  const cwd = workspace(t);
  write(cwd, '.grok-plans/a.md'); write(cwd, '.grok-plans/b.md');
  const report = previewArtifactMigration(cwd, { maxEntries: 1 });
  assert.equal(report.truncated, true); assert.equal(report.complete, false);
  assert.equal(report.files.length, 1);
  assert.ok(report.warnings.some(item => item.reason === 'entry-limit'));
  for (const maxEntries of [0, -1, 1.5, 100001, 'bad']) assert.throws(() => discoverArtifacts(cwd, { maxEntries }), /maxEntries/);
});

test('grok_artifacts uses the companion read-only path and rejects migration execution', async t => {
  const cwd = workspace(t);
  const source = write(cwd, '.grok-docs/report.pdf');
  const before = fs.statSync(source).mtimeMs;
  for (const action of ['discover', 'preview']) {
    const result = await runCompanion('grok_artifacts', { cwd, action, json: true });
    assert.equal(result.isError, false, result.content[0].text);
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.action, action); assert.equal(report.readOnly, true);
    assert.equal(report.files.length, 1);
  }
  assert.deepEqual(fs.readdirSync(cwd), ['.grok-docs']);
  assert.equal(fs.statSync(source).mtimeMs, before);
  assert.throws(() => runCompanion('grok_artifacts', { cwd, action: 'apply' }), /not supported/);
  assert.throws(() => runCompanion('grok_artifacts', { cwd, action: 'preview', apply: true }), /Unknown/);
});
