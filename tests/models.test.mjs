import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEffort,
  normalizeModel
} from "../plugins/grok/scripts/lib/models.mjs";

test("model presets inherit the Grok CLI configured default", () => {
  for (const preset of ["fast", "default", "deep", "grok", "FAST", "Deep"]) {
    assert.equal(normalizeModel(preset), null);
  }
  assert.equal(normalizeModel(undefined), null);
  assert.equal(normalizeModel(""), null);
});

test("explicit model ids pass through unchanged", () => {
  assert.equal(normalizeModel("custom-model"), "custom-model");
  assert.equal(normalizeModel("  custom-model  "), "custom-model");
});

test("fast and deep presets only set reasoning effort", () => {
  assert.equal(normalizeEffort(undefined, "fast"), "low");
  assert.equal(normalizeEffort(undefined, "deep"), "high");
  assert.equal(normalizeEffort(undefined, "default"), null);
  assert.equal(normalizeEffort("medium", "fast"), "medium");
  assert.equal(normalizeEffort("max", null), "xhigh");
  assert.throws(() => normalizeEffort("invalid", null), /Invalid --effort value/);
});
