import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyVerificationContract,
  appendVerificationContract,
  buildImplementationPrompt,
  parseImplementationInput
} from "../plugins/grok/scripts/lib/implementation.mjs";
import { buildCompanionInvocation } from "../plugins/grok/mcp/server.mjs";

const COMPANION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok/scripts/grok-companion.mjs"
);

const IMPLEMENT_INPUT = {
  implementationBrief: "Add full jitter to src/retry.ts. Keep fetchWithRetry public.",
  acceptanceCriteria: ["Retries use full jitter", "Existing retry tests pass"],
  allowedFiles: ["src/retry.ts", "tests/retry.test.ts"],
  forbiddenChanges: ["Do not change public API signatures"],
  verificationCommands: ["npm test"]
};

function markdownList(prompt, heading) {
  const lines = String(prompt).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      break;
    }
    const match = line.match(/^- (.+)$/);
    if (match) {
      items.push(match[1]);
    }
  }
  return items;
}

function sectionBody(prompt, heading) {
  const lines = String(prompt).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim()) {
      body.push(line);
    }
  }
  return body.join("\n");
}

test("parseImplementationInput requires a brief and at least one criterion", () => {
  assert.throws(() => parseImplementationInput({}), /implementationBrief/);
  assert.throws(
    () => parseImplementationInput({ implementationBrief: "x", acceptanceCriteria: [] }),
    /acceptanceCriteria/
  );
  const spec = parseImplementationInput({
    implementationBrief: "  Ship retry jitter  ",
    acceptanceCriteria: ["  jitter  ", "", "tests pass"],
    allowedFiles: "src/retry.ts"
  });
  assert.equal(spec.implementationBrief, "Ship retry jitter");
  assert.deepEqual(spec.acceptanceCriteria, ["jitter", "tests pass"]);
  assert.deepEqual(spec.allowedFiles, ["src/retry.ts"]);
});

test("parallel writers require ownership or worktree isolation", () => {
  assert.throws(
    () => parseImplementationInput({ ...IMPLEMENT_INPUT, allowedFiles: [], parallelWrite: true }),
    /worktree or explicit allowedFiles/
  );
  assert.doesNotThrow(() => parseImplementationInput({
    ...IMPLEMENT_INPUT,
    parallelWrite: true
  }));
  assert.doesNotThrow(() => parseImplementationInput({
    ...IMPLEMENT_INPUT,
    allowedFiles: [],
    parallelWrite: true,
    worktree: true
  }));
});

test("corrections require the same session and respect the retry bound", () => {
  assert.throws(
    () => parseImplementationInput({ ...IMPLEMENT_INPUT, correctionAttempt: 1 }),
    /requires resume/
  );
  assert.throws(
    () => parseImplementationInput({
      ...IMPLEMENT_INPUT,
      resume: true,
      correctionAttempt: 3,
      maxCorrectionAttempts: 2
    }),
    /exceeds/
  );
});

test("buildImplementationPrompt is host-plan-authoritative and reconstructs structured fields", () => {
  const prompt = buildImplementationPrompt(IMPLEMENT_INPUT);

  assert.match(prompt, /host-led Codex/i);
  assert.match(prompt, /host \(Codex\) owns planning and final acceptance/i);
  assert.match(prompt, /Inspect the repository only to validate assumptions/i);
  assert.match(prompt, /Do not expand scope/i);
  assert.match(prompt, /do not replace host verification or host final acceptance/i);
  assert.doesNotMatch(prompt, /enter plan mode/i);
  assert.doesNotMatch(prompt, /## Verification contract/);

  assert.equal(
    sectionBody(prompt, "## Host-approved plan (authoritative)"),
    IMPLEMENT_INPUT.implementationBrief
  );
  assert.deepEqual(
    markdownList(prompt, "## Acceptance criteria"),
    IMPLEMENT_INPUT.acceptanceCriteria
  );
  assert.deepEqual(markdownList(prompt, "## Allowed files"), IMPLEMENT_INPUT.allowedFiles);
  assert.deepEqual(
    markdownList(prompt, "## Forbidden changes"),
    IMPLEMENT_INPUT.forbiddenChanges
  );
  assert.deepEqual(
    markdownList(prompt, "## Verification commands"),
    IMPLEMENT_INPUT.verificationCommands
  );

  const contract = markdownList(prompt, "## Implementation contract");
  assert.ok(contract.some((item) => /authoritative/i.test(item)));
  assert.ok(contract.some((item) => /Implement all requested changes/i.test(item)));
  assert.ok(contract.some((item) => /changed files/i.test(item)));
  assert.ok(contract.some((item) => /pass, fail, or unverified/i.test(item)));
  assert.ok(contract.some((item) => /stop and report/i.test(item)));
  assert.ok(contract.some((item) => /Do not improvise/i.test(item)));
});

test("prompt includes correction and parallel-write contracts", () => {
  const prompt = buildImplementationPrompt({
    ...IMPLEMENT_INPUT,
    resume: true,
    correctionAttempt: 1,
    parallelWrite: true
  });

  assert.match(prompt, /correction 1 of at most 2/i);
  assert.match(prompt, /Parallel-write ownership/);
});

test("grok_implement keeps deep default, check, and resume flags", () => {
  const invocation = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    resume: true,
    correctionAttempt: 1
  });

  assert.equal(invocation.command, "task");
  assert.deepEqual(invocation.args.slice(0, 5), [
    "task",
    "--resume-last",
    "--model",
    "deep",
    "--check"
  ]);
});

test("buildImplementationPrompt omits empty optional sections", () => {
  const prompt = buildImplementationPrompt({
    implementationBrief: "Fix the timeout fluke",
    acceptanceCriteria: ["npm test passes"]
  });
  assert.doesNotMatch(prompt, /## Allowed files/);
  assert.doesNotMatch(prompt, /## Forbidden changes/);
  assert.doesNotMatch(prompt, /## Verification commands/);
  assert.deepEqual(markdownList(prompt, "## Acceptance criteria"), ["npm test passes"]);
});

test("applyVerificationContract is a no-op unless check is enabled", () => {
  const original = "fix the flaky timeout in retry.test.ts";
  assert.equal(applyVerificationContract(original, { check: false }), original);
  assert.equal(applyVerificationContract(original), original);
});

test("applyVerificationContract appends the check contract for grok_rescue check=true", () => {
  const original = "fix the flaky timeout in retry.test.ts";
  const withCheck = applyVerificationContract(original, { check: true });

  assert.ok(withCheck.startsWith(original));
  assert.notEqual(withCheck, original);
  assert.deepEqual(markdownList(withCheck, "## Verification contract"), [
    "Run the relevant tests and static checks for this change.",
    "Report the exact commands you ran and their outcomes.",
    "Never claim success if checks failed or could not be run."
  ]);
});

test("appendVerificationContract is idempotent and shared with grok_implement", () => {
  const implementer = buildImplementationPrompt(IMPLEMENT_INPUT);
  const once = applyVerificationContract(implementer, { check: true });
  const twice = appendVerificationContract(once);

  assert.equal(once.split("## Verification contract").length - 1, 1);
  assert.equal(twice, once);
  assert.doesNotMatch(implementer, /## Verification contract/);
  assert.match(once, /Never claim success if checks failed or could not be run/);
});

test("companion task applies the check contract before the prompt file is written", () => {
  const source = fs.readFileSync(COMPANION_PATH, "utf8");
  const taskStart = source.indexOf("async function commandTask");
  const taskEnd = source.indexOf("async function commandPlan");
  assert.ok(taskStart >= 0 && taskEnd > taskStart, "commandTask body not found");
  const taskBody = source.slice(taskStart, taskEnd);

  assert.match(taskBody, /const prompt = applyVerificationContract\(rawPrompt, \{ check \}\)/);
  assert.match(taskBody, /title: titleFromPrompt\(rawPrompt\)/);
  assert.match(taskBody, /createJobShell\(cwd, \{[\s\S]*prompt,/);

  const shellStart = source.indexOf("function createJobShell");
  const shellEnd = source.indexOf("function runOrBackground");
  assert.ok(shellStart >= 0 && shellEnd > shellStart, "createJobShell body not found");
  const shellBody = source.slice(shellStart, shellEnd);
  assert.match(shellBody, /const promptFile = writePromptFile\(prompt\);/);
});
