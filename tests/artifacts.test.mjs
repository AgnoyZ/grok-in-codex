import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectDesignArtifacts,
  collectDocumentArtifacts,
  collectWorkflowArtifacts,
  extractDesignDocPathFromText,
  preferPlanArtifactText,
  primaryArtifacts,
  resolveExecutePlanDesignPath,
  resolveLatestDesignDoc
} from "../plugins/grok/scripts/lib/artifacts.mjs";

test("extractDesignDocPathFromText reads DESIGN_DOC_PATH marker", () => {
  const p = extractDesignDocPathFromText(
    "Done.\nDESIGN_DOC_PATH=/tmp/scratch/grok-design-doc-abc.md\n"
  );
  assert.equal(p, "/tmp/scratch/grok-design-doc-abc.md");
});

test("resolveLatestDesignDoc picks newest md under .grok/designs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-des-"));
  const dir = path.join(tmp, ".grok/designs");
  fs.mkdirSync(dir, { recursive: true });
  const older = path.join(dir, "old.md");
  const newer = path.join(dir, "new.md");
  fs.writeFileSync(older, "# old\n");
  fs.writeFileSync(newer, "# new\n");
  const past = Date.now() - 60_000;
  fs.utimesSync(older, new Date(past), new Date(past));
  fs.utimesSync(newer, new Date(), new Date());
  assert.equal(resolveLatestDesignDoc(tmp), newer);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveExecutePlanDesignPath --latest uses .grok/designs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-exec-"));
  const dir = path.join(tmp, ".grok/designs");
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, "plan.md");
  fs.writeFileSync(doc, "## PR Plan\n");
  const resolved = resolveExecutePlanDesignPath(tmp, null, { latest: true });
  assert.equal(resolved, doc);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveExecutePlanDesignPath rejects missing explicit path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-exec2-"));
  assert.throws(
    () => resolveExecutePlanDesignPath(tmp, "nope.md", { latest: false }),
    /not found/
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("collectDesignArtifacts copies DESIGN_DOC_PATH into .grok/designs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-harv-"));
  const source = path.join(tmp, "source-design.md");
  fs.writeFileSync(source, "# Design\n\n## PR Plan\n");
  const arts = collectDesignArtifacts(tmp, {
    text: `DESIGN_DOC_PATH=${source}`,
    jobId: "design-1"
  });
  assert.ok(arts.some((a) => a.kind === "design" && a.path === source));
  const copy = arts.find((a) => a.kind === "design-copy");
  assert.ok(copy);
  assert.equal(path.dirname(copy.path), path.join(tmp, '.grok', 'designs'));
  assert.ok(fs.existsSync(copy.path));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("collectWorkflowArtifacts copies report paths into .grok/workflows", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wf-art-"));
  const report = path.join(tmp, "report.md");
  fs.writeFileSync(report, "# report\n");
  const arts = collectWorkflowArtifacts(tmp, {
    text: `Workflow done. Report at: ${report}`,
    jobId: "workflow-1"
  });
  assert.ok(arts.some((a) => a.path === report));
  assert.ok(arts.some((a) => a.kind === "workflow-copy"));
  assert.equal(path.dirname(arts.find(a => a.kind === 'workflow-copy').path), path.join(tmp, '.grok', 'workflows'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('new output leaves legacy artifacts and configuration intact', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-defaults-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const kind of ['plans', 'designs', 'workflows', 'docs', 'reviews', 'media']) {
    fs.mkdirSync(path.join(tmp, `.grok-${kind}`));
    fs.writeFileSync(path.join(tmp, `.grok-${kind}`, 'old.md'), kind);
  }
  fs.mkdirSync(path.join(tmp, '.grok'));
  const config = path.join(tmp, '.grok', 'settings.json');
  fs.writeFileSync(config, '{"user":true}');
  assert.equal(resolveLatestDesignDoc(tmp), null);
  assert.equal(resolveExecutePlanDesignPath(tmp, '.grok-designs/old.md'), path.join(tmp, '.grok-designs', 'old.md'));
  const source = path.join(tmp, 'new.md');
  fs.writeFileSync(source, '# New design');
  const design = collectDesignArtifacts(tmp, { text: `DESIGN_DOC_PATH=${source}`, jobId: 'new' })
    .find(a => a.kind === 'design-copy' && path.basename(a.path) === 'new-new.md');
  assert.ok(design);
  assert.equal(resolveExecutePlanDesignPath(tmp, null, { latest: true }), design.path);
  const pdf = path.join(tmp, 'report.pdf');
  fs.writeFileSync(pdf, 'pdf-bytes');
  const documents = collectDocumentArtifacts(tmp, { text: `DOCUMENT_PATH=\`${pdf}\`` });
  const copy = documents.find(a => a.kind === 'document-copy' && path.basename(a.path) === 'report.pdf');
  assert.ok(copy);
  assert.equal(copy.path, path.join(tmp, '.grok', 'docs', 'report.pdf'));
  assert.equal(fs.readFileSync(copy.path, 'utf8'), 'pdf-bytes');
  assert.equal(fs.readFileSync(config, 'utf8'), '{"user":true}');
  for (const kind of ['plans', 'designs', 'workflows', 'docs', 'reviews', 'media']) {
    assert.deepEqual(fs.readdirSync(path.join(tmp, `.grok-${kind}`)), ['old.md']);
    assert.equal(fs.readFileSync(path.join(tmp, `.grok-${kind}`, 'old.md'), 'utf8'), kind);
  }
});

test("primaryArtifacts prefers project copies", () => {
  const list = primaryArtifacts(
    [
      { kind: "design", path: "/tmp/a.md" },
      { kind: "design-copy", path: "/proj/.grok/designs/a.md" }
    ],
    { limit: 2 }
  );
  assert.equal(list[0].path, "/proj/.grok/designs/a.md");
});

test("preferPlanArtifactText prefers plan.md over narration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plan-text-"));
  const planPath = path.join(tmp, "plan.md");
  fs.writeFileSync(planPath, "# Context\n\nDo the thing with retries.\n");
  const out = preferPlanArtifactText("Entering plan mode and exploring...", [
    { kind: "plan-copy", path: planPath }
  ]);
  assert.match(out, /Do the thing with retries/);
  assert.match(out, /Plan \(from plan\.md\)|Context/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
