#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { buildImplementationPrompt } from "../scripts/lib/implementation.mjs";

const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version;
const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");

const stringSchema = (description) => ({ type: "string", description });
const booleanSchema = (description) => ({ type: "boolean", description });
const integerSchema = (description, minimum = 1) => ({ type: "integer", minimum, description });
const WORKSPACE_PROPERTY = {
  cwd: stringSchema(
    "Workspace or repository path for this call. Pass the active Codex project path when the plugin runs from its install cache."
  )
};

/** Shared control surface for long-running Grok jobs (mirrors Claude companion flags). */
const CONTROL_PROPERTIES = {
  sandbox: stringSchema("Grok sandbox profile (e.g. read-only, workspace)."),
  planMode: booleanSchema("Enable Grok plan mode (--plan)."),
  permissionMode: stringSchema("Permission mode passed to Grok."),
  agent: stringSchema("Grok agent name to use."),
  noSubagents: booleanSchema("Disable Grok subagents."),
  memory: booleanSchema("Enable memory for this session."),
  noMemory: booleanSchema("Disable memory for this session."),
  allow: {
    type: "array",
    items: { type: "string" },
    description: "Permission allow rules (repeatable)."
  },
  deny: {
    type: "array",
    items: { type: "string" },
    description: "Permission deny rules (repeatable)."
  },
  disableWebSearch: booleanSchema("Disable web search tools."),
  forkSession: booleanSchema("Fork the current Grok session."),
  maxTurns: integerSchema("Maximum Grok turns for this job.")
};

const COMMON_JOB_PROPERTIES = {
  ...WORKSPACE_PROPERTY,
  timeoutMinutes: { type: 'number', minimum: 0, description: 'Background wall-clock timeout in minutes (default 60; 0 disables).' },
  background: booleanSchema("Start a background job and return the job id."),
  model: stringSchema("Grok model id or effort preset (fast/deep). Omit it to use the Grok CLI configured default model."),
  effort: stringSchema("Reasoning effort: none, minimal, low, medium, high, xhigh, or max."),
  json: booleanSchema("Return machine-readable JSON from the companion."),
  ...CONTROL_PROPERTIES
};

const TOOL_DEFINITIONS = [
  {
    name: "grok_setup",
    description:
      "Check Grok CLI availability, authentication, min version, and doctor. Optionally toggle the stop review gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        enableReviewGate: booleanSchema("Enable the optional stop review gate."),
        disableReviewGate: booleanSchema("Disable the optional stop review gate."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_rescue",
    description: "Delegate investigation, implementation, or fixes to Grok. Uses an isolated worktree by default; readOnly prevents source edits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: stringSchema("The task for Grok to investigate, implement, or fix."),
        readOnly: booleanSchema("Prevent source edits by running Grok in read-only mode."),
        resume: booleanSchema("Resume the latest Grok task session for this repository."),
        resumeSession: stringSchema("Resume a specific Grok session id."),
        fresh: booleanSchema("Start a fresh Grok session."),
        worktree: booleanSchema("Run edits in a Grok-managed git worktree."),
        worktreeName: stringSchema("Name for a Grok-managed git worktree."),
        worktreeRef: stringSchema("Base ref for the Grok worktree."),
        check: booleanSchema(
          "Require Grok to run relevant tests/static checks and report exact command outcomes. Does not replace host verification."
        ),
        bestOfN: integerSchema("Run N parallel attempts of the same task and keep the best."),
        verbatim: booleanSchema("Avoid adding extra wrapper instructions to the prompt."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_implement",
    description:
      "Host-led implementation: Codex owns the plan and final acceptance; Grok implements a host-approved brief. This tool does not certify host acceptance. Always runs with implementer verification (--check). Defaults to the deep effort preset when no model or effort is supplied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["implementationBrief", "acceptanceCriteria"],
      properties: {
        implementationBrief: stringSchema(
          "Host-approved implementation brief. Codex owns the plan; Grok implements it without expanding scope."
        ),
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          description: "Measurable acceptance criteria the implementer must satisfy."
        },
        allowedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths Grok may change."
        },
        forbiddenChanges: {
          type: "array",
          items: { type: "string" },
          description: "Optional changes Grok must not make."
        },
        verificationCommands: {
          type: "array",
          items: { type: "string" },
          description: "Optional commands Grok should run as implementer checks (not host final acceptance)."
        },
        parallelWrite: booleanSchema(
          "Mark this as one of multiple concurrent write tasks. Requires a worktree or explicit allowedFiles ownership."
        ),
        correctionAttempt: integerSchema(
          "One-based correction round. Requires resume or resumeSession and must not exceed maxCorrectionAttempts."
        ),
        maxCorrectionAttempts: integerSchema(
          "Maximum correction rounds before the host stops and reports the blocker. Defaults to 2."
        ),
        resume: booleanSchema("Resume the latest Grok task session for this repository."),
        resumeSession: stringSchema("Resume a specific Grok session id."),
        fresh: booleanSchema("Start a fresh Grok session."),
        worktree: booleanSchema("Run edits in a Grok-managed git worktree."),
        worktreeName: stringSchema("Name for a Grok-managed git worktree."),
        worktreeRef: stringSchema("Base ref for the Grok worktree."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_plan",
    description:
      "Headless Grok plan mode. Explores the codebase and harvests plan.md into .grok/plans/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("What to plan. Defaults to a generic explore-and-plan brief."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_review",
    description: "Run a structured read-only Grok review of the working tree, branch, or PR.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Optional review focus, such as auth, race conditions, or data loss."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_adversarial_review",
    description: "Ask Grok to challenge a design, branch, working tree, or PR for hidden risks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Design or implementation assumptions Grok should challenge."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_workflow",
    description:
      "List or run Grok Rhai multi-agent workflows. Use action=list (read-only) or action=run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("list (default) or run."),
        name: stringSchema("Workflow name (required for run)."),
        args: {
          type: "array",
          items: { type: "string" },
          description: "Workflow args as key=value pairs."
        },
        validateOnly: booleanSchema("Validate the workflow without executing (read-only)."),
        prompt: stringSchema("Optional free-form prompt passed after flags."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_design",
    description:
      "Run design-doc writer/reviewer loop. Harvests design docs into .grok/designs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("Design brief."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_execute_plan",
    description:
      "Execute a design-doc PR Plan DAG. Pass designDoc path, or latest=true for the newest design.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        designDoc: stringSchema("Path to design doc. Omit with latest=true."),
        latest: booleanSchema("Use the latest design doc under .grok/designs/."),
        concurrency: integerSchema("Parallel PR plan concurrency."),
        dryRun: booleanSchema("Dry-run only (read-only, no yolo)."),
        autoPr: booleanSchema("Open PRs automatically when the plan supports it."),
        noGraphite: booleanSchema("Disable Graphite stacking."),
        resume: stringSchema("Resume a prior execute-plan PLAN_ID."),
        instructions: stringSchema("Extra instructions for the executor."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_babysit",
    description:
      "Watch PRs and fix CI/review issues via pr-babysit. action=list is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("add | list | check | remove. Defaults to list."),
        prs: {
          type: "array",
          items: { type: "string" },
          description: "PR numbers for add/check/remove."
        },
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_document",
    description: "Generate docx, pdf, or pptx via Grok document skills into .grok/docs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: stringSchema("Document type: docx, pdf, or pptx."),
        prompt: stringSchema("Document brief / content request."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_sessions",
    description: "List, search, or export Grok sessions for this workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        action: stringSchema("list (default), search, or export."),
        query: stringSchema("Search query (for search)."),
        sessionId: stringSchema("Session id (for export)."),
        limit: integerSchema("Max sessions to return."),
        output: stringSchema("Export output path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_media",
    description: "Generate or edit images, or generate videos. Pass kind=image or kind=video. Artifacts use .grok/media/.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        ...WORKSPACE_PROPERTY,
        kind: { type: "string", enum: ["image", "video"], description: "Media kind." },
        prompt: stringSchema("Media generation or editing prompt."),
        background: booleanSchema("Start a background job."),
        timeoutMinutes: COMMON_JOB_PROPERTIES.timeoutMinutes,
        edit: stringSchema("Image input for kind=image editing."),
        image: stringSchema("Primary source image for kind=video."),
        refs: { type: "array", items: { type: "string" }, description: "Additional reference images for kind=video." },
        duration: stringSchema("Video duration, commonly 6 or 10."),
        aspect: stringSchema("Aspect ratio, such as 16:9 or 1:1."),
        model: stringSchema("Grok model id or alias."),
        effort: stringSchema("Reasoning effort."),
        out: stringSchema("Output directory, relative to the workspace or absolute."),
        json: booleanSchema("Return machine-readable JSON.")
      }
    }
  },
  {
    name: "grok_job",
    description: "Inspect job status, read results, or cancel a background job. action=cancel requires an explicit jobId.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        action: { type: "string", enum: ["status", "result", "cancel"], default: "status", description: "Job operation." },
        jobId: stringSchema("Job id; required for cancellation."),
        all: booleanSchema("Include older jobs for action=status."),
        maxChars: integerSchema("Result body character limit for action=result (default 20000; 0 disables).", 0),
        json: booleanSchema("Return machine-readable JSON.")
      },
      allOf: [{ if: { properties: { action: { const: "cancel" } }, required: ["action"] }, then: { required: ["jobId"] } }]
    }
  },
  {
    name: "grok_artifacts",
    description: "Read-only discovery of legacy and current unified artifact directories, or a migration preview with path conflicts. Never moves files or changes output paths.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        action: { type: "string", enum: ["discover", "preview"], default: "discover", description: "Discover artifacts or preview legacy-to-.grok path mappings." },
        maxEntries: { type: "integer", minimum: 1, maximum: 100000, description: "Maximum scanned entries including directories (default 10000). Incomplete scans are reported." },
        json: booleanSchema("Return machine-readable discovery or migration preview.")
      }
    }
  },
  {
    name: "grok_transfer",
    description: "Build guidance for transferring host-session context into Grok.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        source: stringSchema("Optional transcript/source path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  }
];

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function resolveUnifiedTool(toolName, input = {}) {
  if (['grok_job', 'grok_media', 'grok_artifacts'].includes(toolName)) {
    const properties = TOOL_MAP.get(toolName).inputSchema.properties;
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`Unknown ${toolName} option: ${key}`);
    }
  }
  if (toolName === 'grok_job') {
    const action = input.action ?? 'status';
    if (!['status', 'result', 'cancel'].includes(action)) throw new Error('grok_job action must be status, result or cancel');
    if (action === 'cancel' && (typeof input.jobId !== 'string' || !input.jobId.trim())) throw new Error('grok_job cancel requires an explicit jobId');
    if (input.all !== undefined && action !== 'status') throw new Error('all is only supported for grok_job status');
    if (input.maxChars !== undefined && action !== 'result') throw new Error('maxChars is only supported for grok_job result');
  } else if (toolName === 'grok_media') {
    if (!['image', 'video'].includes(input.kind)) throw new Error('grok_media kind must be image or video');
    const unsupported = input.kind === 'image' ? ['image', 'refs', 'duration'] : ['edit'];
    for (const key of unsupported) {
      if (input[key] !== undefined) throw new Error(`${key} is not supported for grok_media ${input.kind}`);
    }
  }
  return { toolName, input };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function requiresWorkspaceWrite(toolName, input = {}) {
  ({ toolName, input } = resolveUnifiedTool(toolName, input));
  if (input.dryRun || input.validateOnly) return false;
  if (toolName === 'grok_rescue') return !input.readOnly && !input.planMode && input.permissionMode !== 'plan';
  if (toolName === 'grok_babysit') return String(input.action || 'list').toLowerCase() !== 'list';
  if (toolName === 'grok_workflow') return input.action === 'run';
  return ['grok_implement', 'grok_execute_plan', 'grok_design', 'grok_document', 'grok_media'].includes(toolName);
}

export function isWithinPlugin(cwd, pluginRoot = ROOT_DIR) {
  const relative = path.relative(path.resolve(pluginRoot), path.resolve(cwd));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveMcpCwd(input = {}, toolName, defaultCwd = process.cwd()) {
  if (!hasValue(input.cwd) && requiresWorkspaceWrite(toolName, input) && isWithinPlugin(defaultCwd)) {
    throw new Error('Refusing to write in the plugin installation directory. Pass the project directory as cwd (请传入项目目录作为 cwd).');
  }
  const requested = hasValue(input.cwd) ? String(input.cwd) : defaultCwd;
  const cwd = path.resolve(requested);

  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw new Error(`Workspace directory does not exist: ${cwd}. Pass the project directory as cwd (请传入项目目录作为 cwd).`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${cwd}. Pass the project directory as cwd (请传入项目目录作为 cwd).`);
  }
  return cwd;
}

function pushFlag(args, condition, flag) {
  if (condition) {
    args.push(flag);
  }
}

function pushValue(args, value, flag) {
  if (hasValue(value)) {
    args.push(flag, String(value));
  }
}

function pushArray(args, values, flag) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (hasValue(value)) {
      args.push(flag, String(value));
    }
  }
}

function appendControlArgs(args, input) {
  pushValue(args, input.sandbox, "--sandbox");
  pushFlag(args, input.planMode, "--plan");
  pushValue(args, input.permissionMode, "--permission-mode");
  pushValue(args, input.agent, "--agent");
  pushFlag(args, input.noSubagents, "--no-subagents");
  pushFlag(args, input.memory, "--memory");
  pushFlag(args, input.noMemory, "--no-memory");
  pushArray(args, input.allow, "--allow");
  pushArray(args, input.deny, "--deny");
  pushFlag(args, input.disableWebSearch, "--disable-web-search");
  pushFlag(args, input.forkSession, "--fork-session");
  pushValue(args, input.maxTurns, "--max-turns");
}

function appendCommonJobArgs(args, input) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  appendControlArgs(args, input);
  pushFlag(args, input.json, "--json");
}

function appendReviewArgs(args, input) {
  appendCommonJobArgs(args, input);
  pushValue(args, input.base, "--base");
  pushValue(args, input.scope, "--scope");
  pushValue(args, input.pr, "--pr");
  pushFlag(args, input.postPending, "--post-pending");
  if (hasValue(input.focus)) {
    args.push(String(input.focus));
  }
}

function resolveImplementModel(input) {
  if (hasValue(input.model) || hasValue(input.effort)) {
    return input.model;
  }
  return "deep";
}

function appendTaskResumeArgs(args, input) {
  if (input.resumeSession) {
    pushValue(args, input.resumeSession, "--resume-session");
  } else if (input.resume) {
    args.push("--resume-last");
  } else if (input.fresh) {
    args.push("--fresh");
  }
}

function appendTaskWorktreeArgs(args, input) {
  if (input.worktreeName) {
    pushValue(args, input.worktreeName, "--worktree-name");
  } else {
    pushFlag(args, input.worktree, "--worktree");
    if (input.worktree === false) args.push('--worktree=false');
  }
  pushValue(args, input.worktreeRef, "--worktree-ref");
}

function appendMediaArgs(args, input, kind) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  pushValue(args, input.aspect, "--aspect");
  pushValue(args, input.out, "--out");
  if (kind === "image") {
    pushValue(args, input.edit, "--edit");
  } else {
    pushValue(args, input.image, "--image");
    pushValue(args, input.duration, "--duration");
    for (const ref of input.refs || []) {
      pushValue(args, ref, "--ref");
    }
  }
  pushFlag(args, input.json, "--json");
  if (hasValue(input.prompt)) {
    args.push(String(input.prompt));
  }
}

export function listToolDefinitions() {
  return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
}

export function buildCompanionInvocation(toolName, input = {}) {
  ({ toolName, input } = resolveUnifiedTool(toolName, input));
  if (!TOOL_MAP.has(toolName)) {
    throw new Error(`Unknown Grok tool: ${toolName}`);
  }

  const args = [];
  let command;

  switch (toolName) {
    case 'grok_artifacts': {
      const action = input.action ?? 'discover';
      if (!['discover', 'preview'].includes(action)) throw new Error('grok_artifacts action must be discover or preview; migration execution is not supported');
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(TOOL_MAP.get(toolName).inputSchema.properties, key)) throw new Error(`Unknown artifact option: ${key}`);
      }
      command = 'artifacts';
      args.push(command, action);
      pushValue(args, input.maxEntries, '--max-entries');
      pushFlag(args, input.json, '--json');
      break;
    }
    case "grok_setup":
      command = "setup";
      args.push(command);
      pushFlag(args, input.enableReviewGate, "--enable-review-gate");
      pushFlag(args, input.disableReviewGate, "--disable-review-gate");
      pushFlag(args, input.json, "--json");
      break;
    case "grok_rescue":
      command = "task";
      args.push(command);
      pushFlag(args, input.background, "--background");
      pushFlag(args, input.readOnly, "--read-only");
      if (input.readOnly === false) args.push('--read-only=false');
      appendTaskResumeArgs(args, input);
      pushValue(args, input.model, "--model");
      pushValue(args, input.effort, "--effort");
      appendTaskWorktreeArgs(args, input);
      pushFlag(args, input.check, "--check");
      pushValue(args, input.bestOfN, "--best-of-n");
      pushFlag(args, input.verbatim, "--verbatim");
      appendControlArgs(args, input);
      pushFlag(args, input.json, "--json");
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_implement": {
      command = "task";
      args.push(command);
      args.push('--write');
      pushFlag(args, input.background, "--background");
      appendTaskResumeArgs(args, input);
      pushValue(args, resolveImplementModel(input), "--model");
      pushValue(args, input.effort, "--effort");
      appendTaskWorktreeArgs(args, input);
      args.push("--check");
      appendControlArgs(args, input);
      pushFlag(args, input.json, "--json");
      args.push(buildImplementationPrompt(input));
      break;
    }
    case "grok_plan":
      command = "plan";
      args.push(command);
      appendCommonJobArgs(args, input);
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_review":
      command = "review";
      args.push(command);
      appendReviewArgs(args, input);
      break;
    case "grok_adversarial_review":
      command = "adversarial-review";
      args.push(command);
      appendReviewArgs(args, input);
      break;
    case "grok_workflow": {
      command = "workflow";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      if (action === "run") {
        args.push("run");
        if (hasValue(input.name)) {
          args.push(String(input.name));
        }
        for (const pair of input.args || []) {
          if (hasValue(pair)) {
            args.push("--arg", String(pair));
          }
        }
        pushFlag(args, input.validateOnly, "--validate-only");
        appendCommonJobArgs(args, input);
        if (hasValue(input.prompt)) {
          args.push(String(input.prompt));
        }
      } else {
        args.push("list");
        pushFlag(args, input.json, "--json");
      }
      break;
    }
    case "grok_design":
      command = "design";
      args.push(command);
      appendCommonJobArgs(args, input);
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_execute_plan":
      command = "execute-plan";
      args.push(command);
      if (input.latest) {
        args.push("--latest");
      } else if (hasValue(input.designDoc)) {
        args.push(String(input.designDoc));
      }
      pushValue(args, input.concurrency, "--concurrency");
      pushFlag(args, input.dryRun, "--dry-run");
      pushFlag(args, input.autoPr, "--auto-pr");
      pushFlag(args, input.noGraphite, "--no-graphite");
      pushValue(args, input.resume, "--resume");
      pushValue(args, input.instructions, "--instructions");
      appendCommonJobArgs(args, input);
      break;
    case "grok_babysit": {
      command = "babysit";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      args.push(action);
      for (const pr of input.prs || []) {
        if (hasValue(pr)) {
          args.push(String(pr));
        }
      }
      // list is read-only; still allow background for check/add when requested
      if (action !== "list") {
        appendCommonJobArgs(args, input);
      } else {
        pushFlag(args, input.json, "--json");
      }
      break;
    }
    case "grok_document":
      command = "document";
      args.push(command);
      pushValue(args, input.type, "--type");
      appendCommonJobArgs(args, input);
      if (hasValue(input.prompt)) {
        args.push(String(input.prompt));
      }
      break;
    case "grok_sessions": {
      command = "sessions";
      args.push(command);
      const action = String(input.action || "list").toLowerCase();
      args.push(action);
      if (action === "search" && hasValue(input.query)) {
        args.push(String(input.query));
      }
      if (action === "export" && hasValue(input.sessionId)) {
        args.push(String(input.sessionId));
      }
      pushValue(args, input.limit, "--limit");
      pushValue(args, input.output, "--output");
      pushFlag(args, input.json, "--json");
      break;
    }
    case "grok_media":
      command = input.kind;
      args.push(command);
      appendMediaArgs(args, input, command);
      break;
    case "grok_job":
      command = input.action ?? 'status';
      args.push(command);
      if (command === 'status') pushFlag(args, input.all, '--all');
      if (command === 'result') pushValue(args, input.maxChars, '--max-chars');
      pushFlag(args, input.json, "--json");
      if (hasValue(input.jobId)) {
        args.push(String(input.jobId));
      }
      break;
    case "grok_transfer":
      command = "transfer";
      args.push(command);
      pushValue(args, input.source, "--source");
      pushFlag(args, input.json, "--json");
      break;
  }

  if (hasValue(input.timeoutMinutes)) args.splice(1, 0, '--timeout-minutes', String(input.timeoutMinutes));
  return { command, args };
}

export function runCompanion(toolName, input = {}) {
  const { args } = buildCompanionInvocation(toolName, input);
  const cwd = resolveMcpCwd(input, toolName);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
      });
    });
    child.on("close", (code, signal) => {
      const text = stdout || stderr || `grok companion exited with code ${code ?? signal}`;
      finish({
        isError: code !== 0,
        content: [{ type: "text", text }]
      });
    });
  });
}

/**
 * Codex plugin MCP hosts speak newline-delimited JSON over stdio
 * (same framing as bundled plugins such as sites / codex-security).
 * Do not use LSP Content-Length framing — Codex never sends those headers,
 * so tools/list never completes and grok_* tools never appear in the session.
 */
function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(message) {
  const id = message.id;
  try {
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: message.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "grok-in-codex", version: SERVER_VERSION }
          }
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listToolDefinitions() } };
      case "tools/call": {
        const name = message.params?.name;
        const input = message.params?.arguments || {};
        const result = await runCompanion(name, input);
        return { jsonrpc: "2.0", id, result };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      default:
        if (id === undefined || id === null) {
          return null;
        }
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown method: ${message.method}` }
        };
    }
  } catch (error) {
    if (id === undefined || id === null) {
      return null;
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function startStdioServer() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  lines.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.method === undefined && message.id !== undefined) {
      return;
    }

    void handleRequest(message).then((response) => {
      if (response) {
        sendMessage(response);
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
