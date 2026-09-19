import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectMediaArtifacts,
  copyMediaToDir,
  encodeGrokSessionWorkspaceKey,
  extractArtifactPaths,
  findSessionMediaFiles,
  resolveGrokSessionDir,
  resolveMediaOutputDir
} from "../plugins/grok/scripts/lib/media.mjs";

test("encodeGrokSessionWorkspaceKey percent-encodes slashes", () => {
  const workspace = path.join(os.tmpdir(), "grok-session-key-test");
  const key = encodeGrokSessionWorkspaceKey(workspace);
  assert.equal(key, encodeURIComponent(path.resolve(workspace)));
});

test("resolveGrokSessionDir nests under ~/.grok/sessions", () => {
  const workspace = path.join(os.tmpdir(), "grok-session-dir-test");
  const dir = resolveGrokSessionDir(workspace, "sess-abc");
  assert.ok(dir.includes(path.join(".grok", "sessions")));
  assert.ok(dir.endsWith(path.join(encodeGrokSessionWorkspaceKey(workspace), "sess-abc")));
});

test("copyMediaToDir copies into destination with unique names", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-"));
  const srcDir = path.join(tmp, "src");
  const destDir = path.join(tmp, "dest");
  fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, "shot.png");
  fs.writeFileSync(src, "fake-png");

  const first = copyMediaToDir(src, destDir);
  const second = copyMediaToDir(src, destDir);
  assert.equal(first, path.join(destDir, "shot.png"));
  assert.equal(second, path.join(destDir, "shot-2.png"));
  assert.equal(fs.readFileSync(first, "utf8"), "fake-png");
  assert.equal(fs.readFileSync(second, "utf8"), "fake-png");

  // Already in dest: return same path without duplicating
  const again = copyMediaToDir(first, destDir);
  assert.equal(again, first);
});

test("collectMediaArtifacts copies session files into .grok/media", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cwd-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const sessionId = "019f-test-session";
    const sessionDir = resolveGrokSessionDir(cwd, sessionId);
    const imagesDir = path.join(sessionDir, "images");
    fs.mkdirSync(imagesDir, { recursive: true });
    const sessionFile = path.join(imagesDir, "1.jpg");
    fs.writeFileSync(sessionFile, "jpeg-bytes");

    const destDir = resolveMediaOutputDir(cwd, 'image');
    assert.equal(destDir, path.join(cwd, '.grok', 'media', 'image'));
    assert.equal(resolveMediaOutputDir(cwd, 'video'), path.join(cwd, '.grok', 'media', 'video'));
    const artifacts = collectMediaArtifacts({
      cwd,
      kind: "image",
      outputDir: destDir,
      sessionId,
      sinceMs: Date.now() - 60_000,
      text: `Saved to \`${sessionFile}\``
    });

    assert.equal(artifacts.length, 1);
    assert.ok(artifacts[0].startsWith(destDir));
    assert.ok(fs.existsSync(artifacts[0]));
    assert.equal(fs.readFileSync(artifacts[0], "utf8"), "jpeg-bytes");
  } finally {
    process.env.HOME = prevHome;
  }
});

test("findSessionMediaFiles discovers without relying on text paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cwd-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const sessionId = "sess-video-1";
    const videosDir = path.join(resolveGrokSessionDir(cwd, sessionId), "videos");
    fs.mkdirSync(videosDir, { recursive: true });
    const clip = path.join(videosDir, "clip.mp4");
    fs.writeFileSync(clip, "mp4");

    const found = findSessionMediaFiles(cwd, {
      sessionId,
      sinceMs: Date.now() - 10_000
    });
    assert.ok(found.includes(clip));
  } finally {
    process.env.HOME = prevHome;
  }
});

test("extractArtifactPaths expands ~ paths when file exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = path.join(home, "demo.png");
    fs.writeFileSync(file, "x");
    const paths = extractArtifactPaths("wrote `~/demo.png`", "/tmp");
    assert.deepEqual(paths, [file]);
  } finally {
    process.env.HOME = prevHome;
  }
});
