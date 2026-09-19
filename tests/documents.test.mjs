import assert from "node:assert/strict";
import test from "node:test";

import { buildDocumentPrompt, normalizeDocumentType } from "../plugins/grok/scripts/lib/documents.mjs";

test("normalizeDocumentType accepts pptx pdf docx", () => {
  assert.equal(normalizeDocumentType("pptx"), "pptx");
  assert.equal(normalizeDocumentType(".PDF"), "pdf");
  assert.equal(normalizeDocumentType("docx"), "docx");
});

test("normalizeDocumentType rejects unknown", () => {
  assert.throws(() => normalizeDocumentType("xls"), /Invalid/);
});

test("buildDocumentPrompt includes skill and path marker", () => {
  const p = buildDocumentPrompt({
    type: "pptx",
    brief: "Launch deck for the plugin",
    outputDir: ".grok-docs"
  });
  assert.match(p, /pptx skill/i);
  assert.match(p, /Launch deck/);
  assert.match(p, /\.grok-docs/);
  assert.match(p, /DOCUMENT_PATH=/);
});

test('document prompt defaults to unified output and honors custom output', () => {
  assert.ok(buildDocumentPrompt({ type: 'pdf', brief: 'Report' }).includes('.grok/docs/'));
  const custom = buildDocumentPrompt({ type: 'pdf', brief: 'Report', outputDir: 'reports/custom' });
  assert.ok(custom.includes('reports/custom/'));
  assert.ok(!custom.includes('.grok/docs/'));
});
