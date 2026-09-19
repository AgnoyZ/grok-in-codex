import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildGrokArgs,
  buildGrokBackgroundWrapperSource,
  formatStreamToolMessage,
  formatStreamProgressMessage,
  getStreamProgressHelperSource,
  humanizeGrokFailure,
  parseGrokJsonOutput,
  streamToolPhase
} from "../plugins/grok/scripts/lib/grok.mjs";

test("parseGrokJsonOutput reads success payload", () => {
  const parsed = parseGrokJsonOutput(
    JSON.stringify({
      text: "hello",
      stopReason: "EndTurn",
      sessionId: "sess-1",
      requestId: "req-1"
    })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.sessionId, "sess-1");
});

test("parseGrokJsonOutput reads error payload", () => {
  const parsed = parseGrokJsonOutput(JSON.stringify({ type: "error", message: "nope" }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /nope/);
});

test("buildGrokArgs write mode uses Grok CLI 1.x auto-approval", () => {
  const args = buildGrokArgs({ prompt: "hi", write: true, model: "grok-4.5" });
  assert.ok(args.includes("--always-approve"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-4.5"));
});

test("buildGrokArgs read-only mode uses denylist not allowlist", () => {
  const args = buildGrokArgs({ prompt: "review", write: false });
  assert.ok(!args.includes("--yolo"));
  assert.ok(!args.includes("--always-approve"));
  assert.ok(!args.includes("--tools"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.some((a) => String(a).includes("run_terminal_cmd")));
  assert.ok(args.includes("--rules"));
});

test("buildGrokArgs media mode avoids tools allowlist and yolo", () => {
  const args = buildGrokArgs({
    prompt: "draw a banner",
    media: true,
    write: false,
    yolo: false
  });
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(!args.includes("--always-approve"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.some((a) => String(a).includes("run_terminal_cmd")));
});

test("humanizeGrokFailure maps RequirementError tool dumps", () => {
  const msg = humanizeGrokFailure({
    stderr:
      'RequirementError { message: "run_terminal_cmd background param constraint with --tools allowlist" }',
    exitCode: 1
  });
  assert.match(msg, /tool configuration/i);
  assert.match(msg, /disallowed-tools/i);
  assert.ok(!/RequirementError \{/.test(msg));
});

test("humanizeGrokFailure maps auth failures", () => {
  const msg = humanizeGrokFailure({ stderr: "Error: not logged in" });
  assert.match(msg, /not authenticated/i);
  assert.match(msg, /grok login/i);
});

test("parseGrokJsonOutput humanizes bare RequirementError text", () => {
  const parsed = parseGrokJsonOutput(
    'Error: RequirementError { kind: "tools", detail: "run_terminal_cmd background" }'
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /tool configuration|requirement error/i);
});

test("formatStreamProgressMessage tails accumulated text", () => {
  assert.equal(formatStreamProgressMessage("  hello   world  "), "hello world");
  const long = "a".repeat(200);
  const msg = formatStreamProgressMessage(long);
  assert.equal(msg.length, 160);
  assert.equal(msg, "a".repeat(160));
});

test("formatStreamProgressMessage is empty until non-whitespace content exists", () => {
  // Grok emits truthy whitespace-only thought/text chunks; helper must not invent
  // a prefix-only line — call sites floor empty to "running".
  assert.equal(formatStreamProgressMessage(""), "");
  assert.equal(formatStreamProgressMessage("   "), "");
  assert.equal(formatStreamProgressMessage(" \n\t "), "");
  assert.equal(formatStreamProgressMessage("", { prefix: "thinking: " }), "");
  assert.equal(formatStreamProgressMessage("  ", { prefix: "thinking: " }), "");
  // Floor pattern used by the background worker
  assert.equal(formatStreamProgressMessage(" \n") || "running", "running");
  assert.equal(
    formatStreamProgressMessage("  ", { prefix: "thinking: " }) || "running",
    "running"
  );
});

test("formatStreamProgressMessage tails thinking with prefix (not single token)", () => {
  // Live repro: thought events stream as tiny chunks; progress must show a tail of all of them.
  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const msg = formatStreamProgressMessage(thoughtAcc, { prefix: "thinking: " });
  assert.match(msg, /^thinking: /);
  assert.match(msg, /across the plugin/);
  assert.ok(!/^thinking:  frame\.\.\.$/.test(msg), "must not show only first token");
  // Last token alone would be " across the plugin" — full tail is longer.
  assert.ok(msg.length > "thinking:  across the plugin".length);
});

test("stream tool events expose semantic phases and safe messages", () => {
  assert.equal(streamToolPhase("read"), "inspecting");
  assert.equal(streamToolPhase("search"), "inspecting");
  assert.equal(streamToolPhase("write"), "editing");
  assert.equal(streamToolPhase("edit"), "editing");
  assert.equal(streamToolPhase("execute"), "executing");
  assert.equal(streamToolPhase("plan"), "planning");
  assert.equal(streamToolPhase("unknown"), "working");
  assert.equal(formatStreamToolMessage({ name: "write_file" }, "completed"), "write_file completed");
  assert.equal(formatStreamToolMessage({ title: "run tests" }, "in_progress"), "run tests in progress");
  assert.doesNotMatch(
    formatStreamToolMessage({ name: "run_terminal_command", rawInput: { command: "secret" } }),
    /secret/
  );
});

test("background wrapper embeds the same progress helper tests exercise", () => {
  const helperSrc = getStreamProgressHelperSource();
  assert.ok(helperSrc.includes(formatStreamProgressMessage.toString()));
  assert.ok(helperSrc.includes(streamToolPhase.toString()));
  assert.ok(helperSrc.includes(formatStreamToolMessage.toString()));

  // The string that lands in the worker is the live function body — evaluate it.
  const embedded = new Function(`${helperSrc}; return formatStreamProgressMessage;`)();
  assert.equal(embedded("  hello   world  "), "hello world");
  assert.equal(embedded("a".repeat(200)).length, 160);
  assert.equal(embedded(" \n") || "running", "running");
  assert.equal(embedded("  ", { prefix: "thinking: " }) || "running", "running");

  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const thinking = embedded(thoughtAcc, { prefix: "thinking: " });
  assert.match(thinking, /^thinking: /);
  assert.match(thinking, /across the plugin/);

  const wrapper = buildGrokBackgroundWrapperSource({
    binary: "/usr/bin/true",
    args: ["-p", "hi"],
    resultFile: "/tmp/result.json",
    progressFile: "/tmp/progress.json",
    cwd: "/tmp",
    streaming: true
  });
  assert.ok(
    wrapper.includes(helperSrc),
    "worker script must contain the helper source (not a drifted copy)"
  );
  assert.doesNotThrow(() => new Function(wrapper), "generated worker must be valid JavaScript");
  assert.ok(!wrapper.includes("formatProgressTail"), "old inline copy must be gone");
  assert.match(wrapper, /formatStreamProgressMessage\(thoughtAcc/);
  assert.match(wrapper, /formatStreamProgressMessage\(textAcc/);
  assert.match(wrapper, /evt\.type === "tool_call"/);
  assert.match(wrapper, /evt\.type === "tool_call_update"/);
  assert.match(wrapper, /currentPhase = streamToolPhase\(kind\)/);
  assert.match(wrapper, /lastTool/);
  assert.match(wrapper, /toolCounts/);
  // Call-site floor: empty helper result must not blank /status
  assert.match(
    wrapper,
    /formatStreamProgressMessage\(textAcc,\s*\{\}\)\s*\|\|\s*"running"/
  );
  assert.match(wrapper, /\|\|\s*"running"/g);
  const floors = wrapper.match(/\|\|\s*"running"/g) || [];
  assert.equal(floors.length, 2, "text and thought branches both floor empty progress");
});

test("background wrapper persists structured tool progress", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tool-progress-"));
  try {
    const fakeCli = path.join(tmp, "fake-cli.cjs");
    const resultFile = path.join(tmp, "result.json");
    const progressFile = path.join(tmp, "progress.json");
    fs.writeFileSync(
      fakeCli,
      [
        "console.log(JSON.stringify({type:'tool_call',toolCallId:'call-1',title:'write_file',kind:'write',status:'pending'}));",
        "console.log(JSON.stringify({type:'tool_call_update',toolCallId:'call-1',status:'completed'}));",
        "console.log(JSON.stringify({type:'end',sessionId:'session-1'}));"
      ].join("\n")
    );
    const wrapper = buildGrokBackgroundWrapperSource({
      binary: process.execPath,
      args: [fakeCli],
      resultFile,
      progressFile,
      cwd: tmp,
      streaming: true
    });
    const run = spawnSync(process.execPath, ["-e", wrapper], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 5000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    assert.equal(progress.phase, "completed");
    assert.equal(progress.lastTool.name, "write_file");
    assert.equal(progress.lastTool.kind, "write");
    assert.equal(progress.lastTool.status, "completed");
    assert.equal(progress.toolCounts.write, 1);
    assert.equal(progress.lines, 3);
    assert.match(progress.lastEventAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
