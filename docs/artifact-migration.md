# Artifact directory migration design

Status: discovery and preview implemented in 0.8.0. New generation now defaults to the unified
directories below. Migration execution is not implemented: old artifacts are not moved or deleted.
Explicit output paths and stored job paths remain unchanged. `execute-plan --latest` searches
`.grok/designs/`; use an explicit path to execute an old design document.

## Layout

| Legacy directory (unchanged) | Default for new artifacts |
| --- | --- |
| `.grok-plans/` | `.grok/plans/` |
| `.grok-designs/` | `.grok/designs/` |
| `.grok-workflows/` | `.grok/workflows/` |
| `.grok-docs/` | `.grok/docs/` |
| `.grok-reviews/` | `.grok/reviews/` |
| `.grok-media/` | `.grok/media/` |

Preserve filenames and all relative subdirectories, including media `image/` and `video/`.
Never treat the entire `.grok/` directory as disposable: it can contain CLI configuration or
other unrelated content. Session directories, global job state, user-selected `out` paths,
and unrecognized `.grok-*` directories are outside this migration.

## Implemented read-only interface

`grok_artifacts action=discover cwd=...` inventories both layouts. `action=preview` adds one
operation per legacy regular file, with absolute `source` and `target`, category, byte size,
`ready` or `conflict`, and a conflict reason. Direct CLI usage:

```text
node plugins/grok/scripts/grok-companion.mjs artifacts preview --cwd /path/to/project --json
```

The JSON includes `readOnly=true`, `executionSupported=false`, `requiresRescan=true`, a layout
mapping, operation counts, discovered files, and warnings. Existing destination files or
directories are conflicts; the preview does not hash or deduplicate contents. A file or
symlink in a destination parent blocks that operation. Symlinks/junctions in either layout
are not followed, even when their target is inside the workspace. Empty directories produce
no file operations. Unreadable paths, traversal-depth limits and entry limits make the
inventory incomplete (`complete=false`). No write or apply mode is exposed.

Scanning is not a transactional snapshot: active jobs can create or change files during the
scan. A preview cannot establish that the workspace is idle, or authorize later mutations.

## Requirements before implementing execution

1. Acquire the same canonical workspace write lock as generation jobs. Re-scan under that
   lock and refuse incomplete scans, changed files, existing destinations or linked parents.
   Review/plan jobs can still produce artifacts without the write lock; execution must also
   check the job index for active artifact producers or introduce a maintenance barrier.
2. Inventory references before changing any paths. Known readers/writers include
   `lib/artifacts.mjs` (harvesting and latest-design lookup), `lib/media.mjs`, review artifacts,
   document prompts, companion output-directory defaults, and stored job `artifacts`,
   `designDocPath` and `mediaDir` values. README, plugin skills, user documents, and externally
   saved links may contain literal paths. Do not blindly replace text in arbitrary files.
3. Add a versioned path resolver before automatically relocating existing artifacts. It must find both old
   and new locations during a migration, define ordering for `latest` selection, and handle
   duplicate filenames without silently selecting the wrong artifact. Current generation and
   latest-design lookup use the unified layout; explicit and stored paths are read as recorded.
   Discovery and preview still inventory both layouts without changing them.
4. Choose an explicit conflict policy. The proposed default is to stop rather than overwrite
   or rename silently. Identical-file deduplication, if approved, requires byte/hash verification.
   Recheck case-folding collisions on case-insensitive filesystems.
5. Use copy-and-verify with an on-disk journal, recording source/target paths and hashes.
   Preserve originals until copied files and selected reference updates have been verified.
   Do not use a bulk recursive directory move. Make interrupted execution resumable.
6. Update only the six artifact subdirectory ignore patterns in local Git excludes as needed;
   do not ignore all of `.grok/` or touch unrelated configuration. Resolve Git worktree paths
   through Git, rather than assuming `.git` is a directory.
7. Rollback removes only destinations recorded by this migration whose content still matches
   the journal, restores explicitly changed references, and preserves later user edits.
   Removal of original artifacts is a separate, explicit decision after verification.

These are design requirements for any future migration execution, not commands performed by
discovery or preview. Switching generation defaults does not require moving historical artifacts.
