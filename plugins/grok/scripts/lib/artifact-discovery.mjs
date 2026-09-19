import fs from 'node:fs';
import path from 'node:path';

export const ARTIFACT_LAYOUT = Object.freeze([
  ['plans', '.grok-plans'], ['designs', '.grok-designs'],
  ['workflows', '.grok-workflows'], ['docs', '.grok-docs'],
  ['reviews', '.grok-reviews'], ['media', '.grok-media']
].map(([kind, legacy]) => Object.freeze({ kind, legacy, unified: `.grok/${kind}` })));

// Inspect every existing path component without following symlinks/junctions.
function inspect(cwd, relative) {
  const parts = path.normalize(relative).split(path.sep).filter(Boolean);
  if (parts.includes('..') || path.isAbsolute(relative)) throw new Error('Artifact path must stay within the workspace');
  let current = cwd;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return { kind: 'missing', path: current };
      return { kind: 'error', path: current, reason: error.code || error.message };
    }
    if (stat.isSymbolicLink()) return { kind: 'blocked', path: current, reason: 'symbolic-link' };
    if (index < parts.length - 1 && !stat.isDirectory()) return { kind: 'blocked', path: current, reason: 'parent-not-directory' };
    if (index === parts.length - 1) return { kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'blocked', stat, path: current, reason: 'unsupported-file-type' };
  }
  return { kind: 'directory', path: cwd };
}

export function discoverArtifacts(cwd, { maxEntries = 10000 } = {}) {
  const limit = Number(maxEntries);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error('maxEntries must be an integer between 1 and 100000');
  const workspaceRoot = fs.realpathSync(cwd);
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('Artifact workspace must be a directory');
  const files = [], warnings = [], directories = [];
  let scannedEntries = 0, truncated = false;
  function walk(relative, mapping, layout, depth) {
    if (truncated) return;
    if (depth > 32) { warnings.push({ path: path.join(workspaceRoot, relative), reason: 'depth-limit' }); return; }
    const entry = inspect(workspaceRoot, relative);
    if (entry.kind === 'missing') return;
    if (entry.kind === 'file') {
      files.push({ kind: mapping.kind, layout, path: entry.path, relativePath: relative.split(path.sep).join('/'), sizeBytes: entry.stat.size, modifiedAt: entry.stat.mtime.toISOString() });
      return;
    }
    if (entry.kind !== 'directory') { warnings.push({ path: entry.path, reason: entry.reason }); return; }
    let dir;
    try {
      dir = fs.opendirSync(entry.path);
      let child;
      while ((child = dir.readSync()) !== null) {
        if (scannedEntries >= limit) { truncated = true; warnings.push({ path: entry.path, reason: 'entry-limit' }); break; }
        scannedEntries++;
        walk(path.join(relative, child.name), mapping, layout, depth + 1);
        if (truncated) break;
      }
    } catch (error) { warnings.push({ path: entry.path, reason: error.code || error.message }); }
    finally { if (dir) dir.closeSync(); }
  }
  for (const mapping of ARTIFACT_LAYOUT) {
    for (const layout of ['legacy', 'unified']) {
      const entry = inspect(workspaceRoot, mapping[layout]);
      directories.push({ kind: mapping.kind, layout, path: path.join(workspaceRoot, mapping[layout]), status: entry.kind });
      if (entry.kind === 'file') warnings.push({ path: entry.path, reason: 'artifact-root-not-directory' });
      else walk(mapping[layout], mapping, layout, 0);
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { action: 'discover', readOnly: true, workspaceRoot, complete: !truncated && warnings.length === 0,
    truncated, scannedEntries, maxEntries: limit, directories, files, warnings };
}

export function previewArtifactMigration(cwd, options = {}) {
  const discovery = discoverArtifacts(cwd, options);
  const operations = discovery.files.filter(file => file.layout === 'legacy').map(file => {
    const mapping = ARTIFACT_LAYOUT.find(item => item.kind === file.kind);
    const suffix = path.relative(path.join(discovery.workspaceRoot, mapping.legacy), file.path);
    const relativeTarget = path.join(mapping.unified, suffix);
    const target = path.join(discovery.workspaceRoot, relativeTarget);
    const existing = inspect(discovery.workspaceRoot, relativeTarget);
    return { kind: file.kind, source: file.path, target, sizeBytes: file.sizeBytes,
      status: existing.kind === 'missing' ? 'ready' : 'conflict',
      ...(existing.kind === 'missing' ? {} : { reason: existing.kind === 'file' || existing.kind === 'directory' ? 'target-exists' : existing.reason, blockingPath: existing.path }) };
  });
  return { ...discovery, action: 'preview', executionSupported: false, requiresRescan: true,
    mappings: ARTIFACT_LAYOUT.map(item => ({ ...item })), operations,
    summary: { candidates: operations.length, ready: operations.filter(item => item.status === 'ready').length,
      conflicts: operations.filter(item => item.status === 'conflict').length },
    nextSteps: ['Review conflicts and incomplete-scan warnings.', 'Review documentation, skills and stored job path references before any migration.',
      'Approve a separate migration implementation with copy verification, rollback and reader compatibility; this preview cannot execute moves.'] };
}

export function renderArtifactDiscovery(report) {
  const lines = [`# Grok artifacts: ${report.action}`, '', `Workspace: ${report.workspaceRoot}`,
    `Read-only: true; complete: ${report.complete}; scanned entries: ${report.scannedEntries}`, ''];
  if (report.action === 'preview') {
    lines.push(`Candidates: ${report.summary.candidates}; ready: ${report.summary.ready}; conflicts: ${report.summary.conflicts}`, '', 'Preview only. Migration execution is not supported.', '');
    for (const item of report.operations) lines.push(`- [${item.status}${item.reason ? ': ' + item.reason : ''}] ${JSON.stringify(item.source)} → ${JSON.stringify(item.target)}`);
  } else {
    for (const item of report.files) lines.push(`- [${item.layout}/${item.kind}] ${JSON.stringify(item.path)} (${item.sizeBytes} bytes)`);
    if (!report.files.length) lines.push('No artifacts discovered.');
  }
  if (report.warnings.length) {
    lines.push('', 'Scan warnings:');
    for (const warning of report.warnings) lines.push(`- ${JSON.stringify(warning.path)}: ${warning.reason}`);
  }
  return lines.join('\n') + '\n';
}
