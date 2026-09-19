import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MEDIA_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mov",
  ".mkv"
]);

const SESSION_MEDIA_DIRS = ["images", "videos", "assets"];

export function resolveMediaOutputDir(cwd, kind = "media") {
  const dir = path.join(cwd, ".grok/media", kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Grok stores session media under ~/.grok/sessions/<urlencoded-cwd>/<sessionId>/{images,videos,assets}/
 * Encode matches the CLI: every path segment character, including `/` → %2F.
 */
export function encodeGrokSessionWorkspaceKey(cwd) {
  const resolved = path.resolve(cwd);
  return encodeURIComponent(resolved);
}

/**
 * macOS often has /var → /private/var; Grok may key sessions by either form.
 * Return unique encoded keys for path.resolve, realpath, and /var↔/private/var.
 */
export function encodeGrokSessionWorkspaceKeys(cwd) {
  const paths = new Set();
  const add = (p) => {
    if (!p) return;
    try {
      paths.add(path.resolve(p));
    } catch {
      // ignore
    }
  };
  add(cwd);
  try {
    add(fs.realpathSync.native(cwd));
  } catch {
    try {
      add(fs.realpathSync(cwd));
    } catch {
      // ignore
    }
  }
  // Explicit macOS symlink flip: /var ↔ /private/var
  for (const p of [...paths]) {
    if (p.startsWith("/private/var/")) {
      paths.add(p.replace(/^\/private\/var\//, "/var/"));
    } else if (p.startsWith("/var/")) {
      paths.add(`/private${p}`);
    }
  }
  return [...paths].map((p) => encodeURIComponent(p));
}

export function resolveGrokSessionsRoot() {
  return path.join(os.homedir(), ".grok", "sessions");
}

export function resolveGrokSessionDir(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  const root = resolveGrokSessionsRoot();
  // Prefer the first existing candidate (handles /var vs /private/var).
  for (const key of encodeGrokSessionWorkspaceKeys(cwd)) {
    const dir = path.join(root, key, sessionId);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  // Default to path.resolve encoding (create path for writers)
  return path.join(root, encodeGrokSessionWorkspaceKey(cwd), sessionId);
}

export function resolveGrokWorkspaceSessionsDir(cwd) {
  return path.join(resolveGrokSessionsRoot(), encodeGrokSessionWorkspaceKey(cwd));
}

export function extractArtifactPaths(text, cwd) {
  if (!text) {
    return [];
  }
  const found = new Set();
  const patterns = [
    /`([^`\n]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mkv))`/gi,
    /(?:^|\s)((?:\.\/|\/|~\/)[^\s"'<>]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mkv))/gi,
    /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mkv))/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1].trim().replace(/[.,;:)+]+$/, "");
      const expanded = raw.startsWith("~/")
        ? path.join(process.env.HOME || os.homedir(), raw.slice(2))
        : raw.startsWith("/")
          ? raw
          : path.resolve(cwd, raw);
      found.add(expanded);
    }
  }

  return [...found].filter((filePath) => {
    try {
      return fs.existsSync(filePath) && MEDIA_EXT.has(path.extname(filePath).toLowerCase());
    } catch {
      return false;
    }
  });
}

export function listNewMediaFiles(dir, sinceMs) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  const results = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        const stat = fs.statSync(full);
        if (sinceMs == null || stat.mtimeMs >= sinceMs - 2000) {
          results.push(full);
        }
      } catch {
        // ignore
      }
    }
  };
  walk(dir);
  return results.sort();
}

/**
 * Find media Grok wrote under its session tree for this workspace.
 * Prefer a known sessionId; otherwise scan recent session folders.
 */
export function findSessionMediaFiles(cwd, { sessionId = null, sinceMs = null, maxSessions = 8 } = {}) {
  const found = new Set();

  const collectFromSession = (sessionDir) => {
    if (!sessionDir || !fs.existsSync(sessionDir)) {
      return;
    }
    for (const sub of SESSION_MEDIA_DIRS) {
      for (const file of listNewMediaFiles(path.join(sessionDir, sub), sinceMs)) {
        found.add(file);
      }
    }
    // Also allow media dropped at session root
    for (const file of listNewMediaFiles(sessionDir, sinceMs)) {
      // Avoid walking nested non-media dirs twice: listNewMediaFiles walks all.
      // Only add if path is under images/videos/assets or is a media file at shallow depth.
      const rel = path.relative(sessionDir, file);
      const top = rel.split(path.sep)[0];
      if (SESSION_MEDIA_DIRS.includes(top) || !rel.includes(path.sep)) {
        found.add(file);
      }
    }
  };

  if (sessionId) {
    collectFromSession(resolveGrokSessionDir(cwd, sessionId));
  }

  const workspaceSessions = resolveGrokWorkspaceSessionsDir(cwd);
  if (fs.existsSync(workspaceSessions)) {
    let sessions = [];
    try {
      sessions = fs
        .readdirSync(workspaceSessions, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(workspaceSessions, e.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { full, mtime, name: e.name };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, maxSessions);
    } catch {
      sessions = [];
    }

    for (const session of sessions) {
      if (sessionId && session.name === sessionId) {
        continue; // already collected
      }
      if (sinceMs != null && session.mtime < sinceMs - 60_000) {
        // Session folder older than job start by a wide margin — skip
        continue;
      }
      collectFromSession(session.full);
    }
  }

  return [...found].sort();
}

function uniqueDestPath(destDir, baseName) {
  const dest = path.join(destDir, baseName);
  if (!fs.existsSync(dest)) {
    return dest;
  }
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let i = 2;
  while (fs.existsSync(path.join(destDir, `${stem}-${i}${ext}`))) {
    i += 1;
  }
  return path.join(destDir, `${stem}-${i}${ext}`);
}

/**
 * Copy a media file into destDir unless it already lives there.
 * Returns the path under destDir.
 */
export function copyMediaToDir(sourcePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const resolvedSrc = path.resolve(sourcePath);
  const resolvedDestDir = path.resolve(destDir);
  if (resolvedSrc === resolvedDestDir || resolvedSrc.startsWith(`${resolvedDestDir}${path.sep}`)) {
    return resolvedSrc;
  }
  if (!fs.existsSync(resolvedSrc)) {
    return null;
  }
  const dest = uniqueDestPath(resolvedDestDir, path.basename(resolvedSrc));
  fs.copyFileSync(resolvedSrc, dest);
  return dest;
}

/**
 * Collect media from Grok session dirs + text paths, copy into project .grok/media/<kind>/.
 * Returns absolute paths of project-local artifacts (preferred contract for the plugin).
 */
export function collectMediaArtifacts({
  cwd,
  kind = "image",
  outputDir = null,
  sessionId = null,
  sinceMs = null,
  text = ""
} = {}) {
  const destDir = outputDir || resolveMediaOutputDir(cwd, kind);
  fs.mkdirSync(destDir, { recursive: true });

  const candidates = new Set([
    ...extractArtifactPaths(text, cwd),
    ...listNewMediaFiles(destDir, sinceMs),
    ...findSessionMediaFiles(cwd, { sessionId, sinceMs })
  ]);

  const copied = [];
  for (const src of candidates) {
    try {
      const dest = copyMediaToDir(src, destDir);
      if (dest) {
        copied.push(dest);
      }
    } catch {
      // skip unreadable sources
    }
  }

  return [...new Set(copied)].sort();
}

export function buildImagePrompt({ prompt, edit, outputDir, aspectRatio }) {
  const editLine = edit
    ? `Edit the existing image at: ${edit}\nUse image_edit. Preserve identity/layout unless asked otherwise.`
    : `Generate a new image with image_gen.`;

  return `You are a media generation agent for Claude Code.

${editLine}

User request:
${prompt}

Constraints:
- Use image_gen / image_edit tools. Grok may write files under its session media directories; that is fine.
- Preferred project destination (the companion will also copy session outputs here): ${outputDir}
- Prefer high-quality, production-ready assets
${aspectRatio ? `- Aspect ratio preference: ${aspectRatio}` : ""}
- After generating, reply with absolute paths to every created file (session paths are OK)
- A one-line description of each asset
- Do not modify source code files.
- Do not run shell commands or try to move/copy files yourself.`;
}

export function buildVideoPrompt({ prompt, image, refs, outputDir, duration, aspectRatio }) {
  const sourceLines = [];
  if (image) {
    sourceLines.push(`Animate this source image with image_to_video: ${image}`);
  }
  if (refs?.length) {
    sourceLines.push(
      `Use these reference images with reference_to_video:\n${refs.map((r) => `- ${r}`).join("\n")}`
    );
  }
  if (!sourceLines.length) {
    sourceLines.push(
      "Create a short video. If no image is provided, first generate a still with image_gen, then animate it."
    );
  }

  return `You are a video generation agent for Claude Code.

${sourceLines.join("\n")}

User request:
${prompt}

Constraints:
- Use image_to_video / reference_to_video (and image_gen if needed). Session media paths are fine.
- Preferred project destination (the companion will also copy session outputs here): ${outputDir}
${duration ? `- Target duration: ${duration}s` : "- Target duration: 6s unless specified"}
${aspectRatio ? `- Aspect ratio preference: ${aspectRatio}` : ""}
- Video resolution is limited by the Grok model tier (often 480p); do not claim higher unless the tool reports it.
- After generating, reply with absolute paths to every created video (and intermediate images if useful)
- Do not modify source code files.
- Do not run shell commands or try to move/copy files yourself.`;
}
