import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCompanionInvocation,
  listToolDefinitions,
  resolveMcpCwd,
  runCompanion
} from "../plugins/grok/mcp/server.mjs";
import { buildImplementationPrompt } from "../plugins/grok/scripts/lib/implementation.mjs";
import { normalizeEffort, normalizeModel } from "../plugins/grok/scripts/lib/models.mjs";

const SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok/mcp/server.mjs"
);

const EXPECTED_TOOLS = [
  "grok_adversarial_review",
  "grok_babysit",
  "grok_cancel",
  "grok_design",
  "grok_document",
  "grok_execute_plan",
  "grok_image",
  "grok_implement",
  "grok_plan",
  "grok_rescue",
  "grok_result",
  "grok_review",
  "grok_sessions",
  "grok_setup",
  "grok_status",
  "grok_transfer",
  "grok_video",
  "grok_workflow"
];

test("listToolDefinitions exposes every Grok capability as a Codex tool", () => {
  const names = listToolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
});

test("depth tools for plan/workflow/design/execute/babysit/document/sessions are present", () => {
  const names = new Set(listToolDefinitions().map((tool) => tool.name));
  for (const name of [
    "grok_plan",
    "grok_workflow",
    "grok_design",
    "grok_execute_plan",
    "grok_babysit",
    "grok_document",
    "grok_sessions"
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test("every MCP tool accepts an explicit workspace cwd", () => {
  for (const tool of listToolDefinitions()) {
    assert.ok(tool.inputSchema.properties.cwd, `${tool.name} is missing cwd`);
  }
});

test("MCP companion calls run in the requested workspace", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-workspace-"));
  const response = await runCompanion("grok_status", { cwd: workspace, json: true });
  const payload = JSON.parse(response.content[0].text);

  assert.equal(response.isError, false);
  assert.equal(payload.workspaceRoot, fs.realpathSync(workspace));
});

test("MCP rejects a missing workspace before spawning the companion", () => {
  const missing = path.join(os.tmpdir(), "grok-mcp-missing-workspace");
  assert.throws(() => resolveMcpCwd({ cwd: missing }), /Workspace directory does not exist/);
});

test("buildCompanionInvocation maps review arguments to the companion runtime", () => {
  const invocation = buildCompanionInvocation("grok_review", {
    background: true,
    base: "main",
    scope: "branch",
    focus: "auth and race conditions"
  });

  assert.equal(invocation.command, "review");
  assert.deepEqual(invocation.args, [
    "review",
    "--background",
    "--base",
    "main",
    "--scope",
    "branch",
    "auth and race conditions"
  ]);
});

test("buildCompanionInvocation maps rescue aliases, control flags, and flags", () => {
  const invocation = buildCompanionInvocation("grok_rescue", {
    prompt: "fix flaky tests",
    model: "deep",
    effort: "high",
    worktree: true,
    check: true,
    bestOfN: 3,
    resume: true,
    sandbox: "workspace",
    noSubagents: true,
    maxTurns: 40
  });

  assert.equal(invocation.command, "task");
  assert.deepEqual(invocation.args, [
    "task",
    "--resume-last",
    "--model",
    "deep",
    "--effort",
    "high",
    "--worktree",
    "--check",
    "--best-of-n",
    "3",
    "--sandbox",
    "workspace",
    "--no-subagents",
    "--max-turns",
    "40",
    "fix flaky tests"
  ]);
});

test("buildCompanionInvocation maps plan and execute-plan depth tools", () => {
  const plan = buildCompanionInvocation("grok_plan", {
    prompt: "plan the auth rewrite",
    background: true,
    model: "deep"
  });
  assert.equal(plan.command, "plan");
  assert.ok(plan.args.includes("plan"));
  assert.ok(plan.args.includes("--background"));
  assert.ok(plan.args.includes("plan the auth rewrite"));

  const exec = buildCompanionInvocation("grok_execute_plan", {
    latest: true,
    dryRun: true,
    concurrency: 2
  });
  assert.equal(exec.command, "execute-plan");
  assert.ok(exec.args.includes("--latest"));
  assert.ok(exec.args.includes("--dry-run"));
  assert.ok(exec.args.includes("--concurrency"));
  assert.ok(exec.args.includes("2"));
});

test("buildCompanionInvocation maps workflow list/run and babysit list", () => {
  const list = buildCompanionInvocation("grok_workflow", { action: "list", json: true });
  assert.deepEqual(list.args, ["workflow", "list", "--json"]);

  const run = buildCompanionInvocation("grok_workflow", {
    action: "run",
    name: "review-changes",
    validateOnly: true,
    args: ["scope=branch"]
  });
  assert.ok(run.args.includes("run"));
  assert.ok(run.args.includes("review-changes"));
  assert.ok(run.args.includes("--validate-only"));
  assert.ok(run.args.includes("--arg"));
  assert.ok(run.args.includes("scope=branch"));

  const babysit = buildCompanionInvocation("grok_babysit", { action: "list", json: true });
  assert.deepEqual(babysit.args, ["babysit", "list", "--json"]);
});

test("buildCompanionInvocation maps sessions and document tools", () => {
  const sessions = buildCompanionInvocation("grok_sessions", {
    action: "search",
    query: "auth",
    limit: 5,
    json: true
  });
  assert.ok(sessions.args.includes("sessions"));
  assert.ok(sessions.args.includes("search"));
  assert.ok(sessions.args.includes("auth"));

  const doc = buildCompanionInvocation("grok_document", {
    type: "pdf",
    prompt: "one-pager",
    background: true
  });
  assert.equal(doc.command, "document");
  assert.ok(doc.args.includes("--type"));
  assert.ok(doc.args.includes("pdf"));
  assert.ok(doc.args.includes("one-pager"));
});

const IMPLEMENT_INPUT = {
  implementationBrief: "Add full jitter to src/retry.ts. Keep fetchWithRetry public.",
  acceptanceCriteria: ["Retries use full jitter", "Existing retry tests pass"],
  allowedFiles: ["src/retry.ts", "tests/retry.test.ts"],
  forbiddenChanges: ["Do not change public API signatures"],
  verificationCommands: ["npm test"]
};

function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

test("grok_implement schema requires a brief and criteria and accepts cwd", () => {
  const tool = listToolDefinitions().find((entry) => entry.name === "grok_implement");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["implementationBrief", "acceptanceCriteria"]);
  assert.ok(tool.inputSchema.properties.cwd);
  assert.ok(tool.inputSchema.properties.implementationBrief);
  assert.ok(tool.inputSchema.properties.acceptanceCriteria);
  assert.ok(tool.inputSchema.properties.resumeSession);
  assert.ok(tool.inputSchema.properties.sandbox);
  assert.equal(tool.inputSchema.properties.check, undefined);
});

test("grok_implement maps to task --check with a composed implementer prompt", () => {
  const invocation = buildCompanionInvocation("grok_implement", IMPLEMENT_INPUT);
  assert.equal(invocation.command, "task");
  assert.equal(invocation.args[0], "task");
  assert.ok(invocation.args.includes("--check"));
  assert.deepEqual(flagValues(invocation.args, "--model"), ["deep"]);
  assert.ok(!invocation.args.includes("--effort"));

  const prompt = invocation.args.at(-1);
  assert.equal(prompt, buildImplementationPrompt(IMPLEMENT_INPUT));
  assert.match(prompt, /Add full jitter to src\/retry\.ts/);
  assert.match(prompt, /Retries use full jitter/);
  assert.match(prompt, /src\/retry\.ts/);
  assert.match(prompt, /Do not change public API signatures/);
  assert.match(prompt, /npm test/);
  assert.doesNotMatch(prompt, /## Verification contract/);
});

test("grok_implement defaults to the deep effort preset without pinning a model id", () => {
  const invocation = buildCompanionInvocation("grok_implement", {
    implementationBrief: "Ship the host-approved retry change",
    acceptanceCriteria: ["Existing tests pass"]
  });
  const models = flagValues(invocation.args, "--model");
  assert.deepEqual(models, ["deep"]);
  assert.equal(normalizeModel(models[0]), null);
  assert.equal(normalizeEffort(undefined, models[0]), "high");
  assert.ok(!invocation.args.includes("--effort"));
});

test("grok_implement preserves explicit model and effort overrides", () => {
  const withModel = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    model: "custom-model"
  });
  assert.deepEqual(flagValues(withModel.args, "--model"), ["custom-model"]);
  assert.equal(normalizeModel("custom-model"), "custom-model");
  assert.ok(!withModel.args.includes("--effort"));

  const withPreset = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    model: "fast"
  });
  assert.deepEqual(flagValues(withPreset.args, "--model"), ["fast"]);
  assert.equal(normalizeModel("fast"), null);
  assert.equal(normalizeEffort(undefined, "fast"), "low");

  const withEffort = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    effort: "low"
  });
  assert.ok(!withEffort.args.includes("--model"));
  assert.deepEqual(flagValues(withEffort.args, "--effort"), ["low"]);

  const withBoth = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    model: "fast",
    effort: "medium"
  });
  assert.deepEqual(flagValues(withBoth.args, "--model"), ["fast"]);
  assert.deepEqual(flagValues(withBoth.args, "--effort"), ["medium"]);
  assert.ok(!withBoth.args.includes("deep"));
});

test("grok_implement resumeSession takes precedence over resume and fresh", () => {
  const session = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    resumeSession: "sess-123",
    resume: true,
    fresh: true
  });
  assert.deepEqual(flagValues(session.args, "--resume-session"), ["sess-123"]);
  assert.ok(!session.args.includes("--resume-last"));
  assert.ok(!session.args.includes("--fresh"));

  const resumeLast = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    resume: true,
    fresh: true
  });
  assert.ok(resumeLast.args.includes("--resume-last"));
  assert.ok(!resumeLast.args.includes("--resume-session"));
  assert.ok(!resumeLast.args.includes("--fresh"));

  const fresh = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    fresh: true
  });
  assert.ok(fresh.args.includes("--fresh"));
  assert.ok(!fresh.args.includes("--resume-last"));
  assert.ok(!fresh.args.includes("--resume-session"));
});

test("grok_implement forwards control flags, worktree, background, and json", () => {
  const invocation = buildCompanionInvocation("grok_implement", {
    ...IMPLEMENT_INPUT,
    background: true,
    json: true,
    worktreeName: "impl-1",
    worktreeRef: "main",
    sandbox: "workspace",
    noSubagents: true,
    memory: true,
    maxTurns: 20
  });

  assert.ok(invocation.args.includes("--background"));
  assert.ok(invocation.args.includes("--json"));
  assert.ok(invocation.args.includes("--check"));
  assert.deepEqual(flagValues(invocation.args, "--worktree-name"), ["impl-1"]);
  assert.deepEqual(flagValues(invocation.args, "--worktree-ref"), ["main"]);
  assert.ok(!invocation.args.includes("--worktree"));
  assert.deepEqual(flagValues(invocation.args, "--sandbox"), ["workspace"]);
  assert.ok(invocation.args.includes("--no-subagents"));
  assert.ok(invocation.args.includes("--memory"));
  assert.deepEqual(flagValues(invocation.args, "--max-turns"), ["20"]);
});

test("grok_implement requires a brief and at least one acceptance criterion", () => {
  assert.throws(() => buildCompanionInvocation("grok_implement", {}), /implementationBrief/);
  assert.throws(
    () => buildCompanionInvocation("grok_implement", { implementationBrief: "x" }),
    /acceptanceCriteria/
  );
  assert.throws(
    () =>
      buildCompanionInvocation("grok_implement", {
        implementationBrief: "x",
        acceptanceCriteria: []
      }),
    /acceptanceCriteria/
  );
  assert.throws(
    () =>
      buildCompanionInvocation("grok_implement", {
        implementationBrief: "   ",
        acceptanceCriteria: ["done"]
      }),
    /implementationBrief/
  );
});

/**
 * Codex speaks newline-delimited JSON over stdio for plugin MCP servers.
 * Content-Length framing must not be required or emitted.
 */
test("stdio MCP transport speaks NDJSON (Codex framing)", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-stdio-workspace-"));
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-tools-test", version: "0.0.0" }
    }
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "grok_status",
      arguments: { cwd: workspace, json: true }
    }
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // incomplete trailing line
      }
    }
    const init = parsed.find((m) => m.id === 1);
    const tools = parsed.find((m) => m.id === 2);
    const status = parsed.find((m) => m.id === 3);
    if (init && tools && status) {
      child.kill();
      assert.equal(init.result?.serverInfo?.name, "grok-in-codex");
      assert.equal(init.result?.serverInfo?.version, "0.6.0");
      assert.ok(Array.isArray(tools.result?.tools));
      assert.equal(tools.result.tools.length, EXPECTED_TOOLS.length);
      assert.ok(tools.result.tools.some((t) => t.name === "grok_implement"));
      assert.ok(tools.result.tools.some((t) => t.name === "grok_plan"));
      assert.ok(tools.result.tools.some((t) => t.name === "grok_workflow"));
      assert.equal(status.result?.isError, false);
      assert.equal(
        JSON.parse(status.result.content[0].text).workspaceRoot,
        fs.realpathSync(workspace)
      );
      assert.doesNotMatch(stdout, /Content-Length:/i);
      assert.equal(stderr.trim(), "");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  child.kill();
  assert.fail(
    `NDJSON MCP handshake timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
});
