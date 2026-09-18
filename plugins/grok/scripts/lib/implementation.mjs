/**
 * Host-led implementation prompts. Codex owns planning and final acceptance;
 * Grok implements a host-approved brief. The MCP tool does not certify host
 * acceptance — companion `--check` only asks Grok to run and report checks.
 */

export function normalizeStringList(value) {
  if (value == null || value === false || value === "") {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const trimmed = String(item ?? "").trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out;
}

export function parseImplementationInput(input = {}) {
  const implementationBrief = String(input.implementationBrief ?? "").trim();
  if (!implementationBrief) {
    throw new Error("implementationBrief is required");
  }

  const acceptanceCriteria = normalizeStringList(input.acceptanceCriteria);
  if (acceptanceCriteria.length === 0) {
    throw new Error("acceptanceCriteria must contain at least one criterion");
  }

  const allowedFiles = normalizeStringList(input.allowedFiles);
  const correctionAttempt = input.correctionAttempt == null
    ? null
    : Number(input.correctionAttempt);
  const maxCorrectionAttempts = input.maxCorrectionAttempts == null
    ? 2
    : Number(input.maxCorrectionAttempts);

  if (!Number.isInteger(maxCorrectionAttempts) || maxCorrectionAttempts < 1) {
    throw new Error("maxCorrectionAttempts must be a positive integer");
  }
  if (correctionAttempt != null) {
    if (!Number.isInteger(correctionAttempt) || correctionAttempt < 1) {
      throw new Error("correctionAttempt must be a positive integer");
    }
    if (!input.resume && !input.resumeSession) {
      throw new Error("correctionAttempt requires resume or resumeSession");
    }
    if (correctionAttempt > maxCorrectionAttempts) {
      throw new Error("correctionAttempt exceeds maxCorrectionAttempts");
    }
  }

  if (input.parallelWrite && !input.worktree && !input.worktreeName && allowedFiles.length === 0) {
    throw new Error("parallelWrite requires a worktree or explicit allowedFiles ownership");
  }

  return {
    implementationBrief,
    acceptanceCriteria,
    allowedFiles,
    forbiddenChanges: normalizeStringList(input.forbiddenChanges),
    verificationCommands: normalizeStringList(input.verificationCommands),
    parallelWrite: Boolean(input.parallelWrite),
    correctionAttempt,
    maxCorrectionAttempts
  };
}

function formatList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function optionalSection(title, items) {
  if (!items.length) {
    return [];
  }
  return ["", `## ${title}`, formatList(items)];
}

/**
 * Compose one authoritative implementer prompt. Does not include the
 * companion `--check` verification contract; that is appended later so
 * grok_implement and grok_rescue share one helper.
 */
export function buildImplementationPrompt(input = {}) {
  const spec = parseImplementationInput(input);
  const correctionSection = spec.correctionAttempt == null
    ? []
    : [
        "",
        "## Correction round",
        `This is correction ${spec.correctionAttempt} of at most ${spec.maxCorrectionAttempts}. Preserve accepted work and address only the remaining gaps in the host brief.`
      ];
  const parallelSection = !spec.parallelWrite
    ? []
    : [
        "",
        "## Parallel-write ownership",
        "This task is one writer in a parallel implementation. Modify only the assigned files or isolated worktree. Stop if the required change crosses another writer's ownership."
      ];

  return [
    "You are the implementer in a host-led Codex → Grok workflow.",
    "",
    "The host (Codex) owns planning and final acceptance. You implement the host-approved plan. Inspect the repository only to validate assumptions. Do not expand scope. Do not re-plan, open a design doc, or substitute a different approach.",
    "Your own test runs do not replace host verification or host final acceptance.",
    "",
    "## Host-approved plan (authoritative)",
    spec.implementationBrief,
    "",
    "## Acceptance criteria",
    formatList(spec.acceptanceCriteria),
    ...optionalSection("Allowed files", spec.allowedFiles),
    ...optionalSection("Forbidden changes", spec.forbiddenChanges),
    ...optionalSection("Verification commands", spec.verificationCommands),
    ...correctionSection,
    ...parallelSection,
    "",
    "## Implementation contract",
    "- Treat the host-approved plan as authoritative.",
    "- Implement all requested changes in this brief.",
    "- Stay inside allowed-file and forbidden-change constraints when they are provided.",
    "- If verification commands are listed, run them and report exact results.",
    "- Report exact changed files, commands with outcomes, and remaining risks.",
    "- Report every acceptance criterion as pass, fail, or unverified, with concrete evidence.",
    "- If constraints conflict or a required change is blocked, stop and report the conflict. Do not improvise around it."
  ].join("\n");
}

const VERIFICATION_CONTRACT = [
  "## Verification contract",
  "- Run the relevant tests and static checks for this change.",
  "- Report the exact commands you ran and their outcomes.",
  "- Never claim success if checks failed or could not be run."
].join("\n");

/**
 * Append the companion `--check` contract before the prompt file is written.
 * Idempotent if the heading is already present.
 */
export function appendVerificationContract(prompt) {
  const body = String(prompt ?? "").trimEnd();
  if (body.includes("## Verification contract")) {
    return `${body}\n`;
  }
  if (!body) {
    return `${VERIFICATION_CONTRACT}\n`;
  }
  return `${body}\n\n${VERIFICATION_CONTRACT}\n`;
}

/**
 * Apply the `--check` contract only when check is enabled, immediately
 * before the companion writes the prompt file.
 */
export function applyVerificationContract(prompt, { check = false } = {}) {
  if (!check) {
    return String(prompt ?? "");
  }
  return appendVerificationContract(prompt);
}
