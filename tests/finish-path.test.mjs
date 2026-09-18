import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGrokArgs, parseGrokJsonOutput, runGrok } from "../plugins/grok/scripts/lib/grok.mjs";
import { extractUsageFromParsed } from "../plugins/grok/scripts/lib/usage.mjs";

const MOCK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "helpers/mock-grok.mjs"
);

test("mock GROK_BINARY finish path returns usage and text", () => {
  const prev = process.env.GROK_BINARY;
  process.env.GROK_BINARY = process.execPath;
  try {
    const result = runGrok({
      binaryArgs: [MOCK],
      prompt: "hello",
      write: false,
      cwd: process.cwd()
    });
    assert.equal(result.ok, true);
    assert.equal(result.parsed.text, "mock-ok");
    assert.ok(result.parsed.sessionId);
    const usage = extractUsageFromParsed(result.parsed.parsed || result.parsed);
    // parseGrokJsonOutput may not attach usage on parsed root — read from raw
    const fromRaw = parseGrokJsonOutput(result.stdout);
    assert.equal(fromRaw.ok, true);
    // usage fields live on the JSON object; extractUsageFromParsed should see them
    const u = extractUsageFromParsed(JSON.parse(result.stdout));
    assert.equal(u.num_turns, 1);
    assert.equal(u.total_tokens, 15);
  } finally {
    if (prev === undefined) delete process.env.GROK_BINARY;
    else process.env.GROK_BINARY = prev;
  }
});

test("buildGrokArgs stop-gate safer posture flags", () => {
  const args = buildGrokArgs({
    prompt: "review",
    write: false,
    sandbox: "read-only",
    noSubagents: true,
    yolo: false
  });
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(args.includes("--disallowed-tools"));
});
