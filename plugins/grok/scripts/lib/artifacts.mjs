import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  encodeGrokSessionWorkspaceKey,
  resolveGrokSessionDir,
  resolveGrokSessionsRoot
} from "./media.mjs";

/**
 * Ensure a project-local artifact dir exists and is returned.
 */
export function ensureProjectArtifactDir(cwd, name) {
  const dir = path.join(cwd, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy a file into destDir; returns dest path or null.
 */
export function copyIntoDir(sourcePath, destDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(sourcePath);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    const stamp = Date.now().toString(36);
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    dest = path.join(destDir, `${stem}-${stamp}${ext}`);
  }
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

/**
 * Collect plan.md from Grok session dir; copy into .grok/plans/.
 */
export function collectPlanArtifacts(cwd, sessionId, { jobId = null } = {}) {
  const artifacts = [];
  if (!sessionId) {
    return artifacts;
  }
  const sessionDir = resolveGrokSessionDir(cwd, sessionId);
  const planPath = path.join(sessionDir, "plan.md");
  if (!fs.existsSync(planPath)) {
    return artifacts;
  }
  artifacts.push({ kind: "plan", path: planPath, label: "session plan.md" });
  const destDir = ensureProjectArtifactDir(cwd, ".grok/plans");
  const name = jobId ? `${jobId}-plan.md` : `plan-${sessionId.slice(0, 8)}.md`;
  const dest = path.join(destDir, name);
  fs.copyFileSync(planPath, dest);
  artifacts.push({ kind: "plan-copy", path: dest, label: "project plan copy" });
  return artifacts;
}

/**
 * Extract design doc path markers from agent text (DESIGN_DOC_PATH=...).
 */
export function extractDesignDocPathFromText(text) {
  const pathMarkers = [
    /DESIGN_DOC_PATH\s*=\s*(\S+)/i,
    /design document (?:is )?at:\s*(\S+\.md)/i,
    /wrote (?:the )?design document to:\s*(\S+\.md)/i
  ];
  for (const re of pathMarkers) {
    const m = String(text || "").match(re);
    if (m?.[1]) {
      return m[1].replace(/[`'"]/g, "").replace(/[.,;:]+$/, "");
    }
  }
  return null;
}

/**
 * Resolve the newest design document under project `.grok/designs/`.
 * Returns absolute path or null.
 */
export function resolveLatestDesignDoc(cwd) {
  const dir = path.join(cwd, ".grok/designs");
  if (!fs.existsSync(dir)) {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

/**
 * Resolve execute-plan design path: explicit path, or --latest / missing → newest in .grok/designs.
 */
export function resolveExecutePlanDesignPath(cwd, designDocPath, { latest = false } = {}) {
  if (designDocPath && designDocPath !== "latest" && designDocPath !== "--latest") {
    const abs = path.isAbsolute(designDocPath)
      ? designDocPath
      : path.resolve(cwd, designDocPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Design document not found: ${designDocPath}`);
    }
    return abs;
  }
  if (latest || !designDocPath || designDocPath === "latest") {
    const found = resolveLatestDesignDoc(cwd);
    if (!found) {
      throw new Error(
        "No design document found under .grok/designs/. Run /grok:design first or pass an explicit path."
      );
    }
    return found;
  }
  throw new Error("execute-plan requires <design-doc-path>, --latest, or --resume <PLAN_ID>");
}

/**
 * Find design doc files in text/scratch/session and copy to .grok/designs/.
 */
export function collectDesignArtifacts(cwd, { sessionId = null, text = "", jobId = null } = {}) {
  const artifacts = [];
  const candidates = [];

  const marked = extractDesignDocPathFromText(text);
  if (marked) {
    candidates.push(marked);
  }

  // Scratch pattern (Grok design skill layout)
  const tmpRoot = process.env.TMPDIR || os.tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const scratchHint = path.join(tmpRoot, `grok-${uid}`);
  if (fs.existsSync(scratchHint)) {
    try {
      for (const name of fs.readdirSync(scratchHint)) {
        if (/^grok-design-doc-.*\.md$/i.test(name)) {
          candidates.push(path.join(scratchHint, name));
        }
      }
    } catch {
      // ignore
    }
  }

  if (sessionId) {
    const sessionDir = resolveGrokSessionDir(cwd, sessionId);
    walkMdFiles(sessionDir, candidates, 2);
  }

  // Existing project designs (prefer recent copies)
  const designsDir = path.join(cwd, ".grok/designs");
  if (fs.existsSync(designsDir)) {
    walkMdFiles(designsDir, candidates, 1);
  }

  const destDir = ensureProjectArtifactDir(cwd, ".grok/designs");
  const seen = new Set();
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      continue;
    }
    seen.add(abs);
    artifacts.push({ kind: "design", path: abs, label: "design document" });
    if (!abs.startsWith(destDir + path.sep) && abs !== destDir) {
      const destName = jobId ? `${jobId}-${path.basename(abs)}` : path.basename(abs);
      const dest = path.join(destDir, destName);
      try {
        if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(abs).mtimeMs) {
          fs.copyFileSync(abs, dest);
        }
        artifacts.push({ kind: "design-copy", path: dest, label: "project design copy" });
      } catch {
        // ignore copy failures
      }
    }
  }
  return dedupeArtifacts(artifacts);
}

/**
 * Harvest workflow report / scratch paths from text; copy into .grok/workflows/.
 */
export function collectWorkflowArtifacts(cwd, { text = "", jobId = null } = {}) {
  const artifacts = [];
  const candidates = [];
  const pathMarkers = [
    /WORKFLOW_RESULT_PATH\s*=\s*(\S+)/i,
    /scratch\/([^\s`'"]+)/i,
    /report (?:at|path)[:\s]+(\S+\.md)/i,
    /complete\([^)]*path[^)]*['"]([^'"]+)['"]/i
  ];
  for (const re of pathMarkers) {
    const m = String(text || "").match(re);
    if (m?.[1]) {
      candidates.push(m[1].replace(/[`'"]/g, ""));
    }
  }
  // Absolute or relative .md paths in backticks
  const tick = String(text || "").matchAll(/`([^`]+\.(?:md|json|txt))`/g);
  for (const m of tick) {
    candidates.push(m[1]);
  }

  const destDir = ensureProjectArtifactDir(cwd, ".grok/workflows");
  const seen = new Set();
  for (const candidate of candidates) {
    let abs = candidate;
    if (!path.isAbsolute(abs)) {
      abs = path.resolve(cwd, candidate);
    }
    if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      continue;
    }
    seen.add(abs);
    artifacts.push({ kind: "workflow", path: abs, label: "workflow artifact" });
    const copied = copyIntoDir(abs, destDir);
    if (copied) {
      const renamed =
        jobId && !path.basename(copied).startsWith(jobId)
          ? (() => {
              const dest = path.join(destDir, `${jobId}-${path.basename(copied)}`);
              try {
                fs.renameSync(copied, dest);
                return dest;
              } catch {
                return copied;
              }
            })()
          : copied;
      artifacts.push({ kind: "workflow-copy", path: renamed, label: "project workflow copy" });
    }
  }
  return dedupeArtifacts(artifacts);
}

/**
 * Primary artifact paths for status/result (prefer project copies).
 */
export function primaryArtifacts(artifacts, { limit = 5 } = {}) {
  const list = normalizeArtifactList(artifacts);
  const preferred = list.filter((a) =>
    /-(copy|copy)$|design-copy|plan-copy|workflow-copy|document-copy|project/i.test(
      String(a.kind || "")
    )
  );
  const rest = list.filter((a) => !preferred.includes(a));
  return [...preferred, ...rest].slice(0, limit);
}

/**
 * Prefer harvested plan.md body over plan-mode narration for user-visible Output.
 */
export function preferPlanArtifactText(resultText, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const preferred =
    list.find((a) => a && (a.kind === "plan-copy" || a.kind === "plan")) || null;
  const planPath = preferred?.path;
  if (!planPath || !fs.existsSync(planPath)) {
    return resultText;
  }
  try {
    const body = fs.readFileSync(planPath, "utf8").trim();
    if (!body) {
      return resultText;
    }
    const narration = String(resultText || "").trim();
    if (
      narration &&
      narration.length < body.length &&
      !/^(#|\*\*)\s*(context|approach|plan)/im.test(narration)
    ) {
      return `${narration}\n\n---\n\n## Plan (from plan.md)\n\n${body}`;
    }
    return body;
  } catch {
    return resultText;
  }
}

/**
 * Collect document artifacts (docx/pdf/pptx) into .grok/docs/.
 */
export function collectDocumentArtifacts(cwd, { text = "", sessionId = null, jobId = null, sinceMs = null } = {}) {
  const artifacts = [];
  const destDir = ensureProjectArtifactDir(cwd, ".grok/docs");
  const exts = new Set([".docx", ".pdf", ".pptx", ".dotx"]);
  const candidates = [];

  // Paths mentioned in text
  const pathRe = /(?:^|[\s`'"(])(\/?[^\s`'")]+?\.(?:docx|pdf|pptx|dotx))/gi;
  let match;
  while ((match = pathRe.exec(String(text)))) {
    candidates.push(match[1]);
  }

  if (sessionId) {
    const sessionDir = resolveGrokSessionDir(cwd, sessionId);
    collectFilesByExt(sessionDir, exts, candidates, 3);
  }

  // Recent files under session workspace root
  try {
    const key = encodeGrokSessionWorkspaceKey(cwd);
    const root = path.join(resolveGrokSessionsRoot(), key);
    if (fs.existsSync(root)) {
      collectFilesByExt(root, exts, candidates, 3, sinceMs);
    }
  } catch {
    // ignore
  }

  // Project .grok/docs already
  collectFilesByExt(destDir, exts, candidates, 1, sinceMs);

  const seen = new Set();
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      continue;
    }
    seen.add(abs);
    artifacts.push({ kind: "document", path: abs });
    if (!abs.startsWith(destDir)) {
      const copied = copyIntoDir(abs, destDir);
      if (copied) {
        artifacts.push({ kind: "document-copy", path: copied });
      }
    }
  }

  if (jobId && artifacts.length === 0) {
    // no-op; keep empty
  }
  return dedupeArtifacts(artifacts);
}

export function normalizeArtifactList(artifacts) {
  if (!artifacts?.length) {
    return [];
  }
  return artifacts.map((a) => {
    if (typeof a === "string") {
      return { kind: "file", path: a };
    }
    return a;
  });
}

export function artifactPathsOnly(artifacts) {
  return normalizeArtifactList(artifacts).map((a) => a.path).filter(Boolean);
}

function dedupeArtifacts(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function walkMdFiles(dir, out, depth, filter = null) {
  if (depth < 0 || !dir || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkMdFiles(full, out, depth - 1, filter);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (!filter || filter(entry.name)) {
        out.push(full);
      }
    }
  }
}

function collectFilesByExt(dir, exts, out, depth, sinceMs = null) {
  if (depth < 0 || !dir || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      collectFilesByExt(full, exts, out, depth - 1, sinceMs);
    } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      if (sinceMs != null) {
        try {
          if (fs.statSync(full).mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
      }
      out.push(full);
    }
  }
}
