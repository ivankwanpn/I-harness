# Large workspaces: the instruction watcher failed at startup

Status: **fixed 2026-11-07** (rc7). Found by running the CLI `run` in the I-harness checkout root.

## Symptom

`node ih.mjs run` in the repository root failed before any model call:

    error: Observed instructions unavailable        (code CONTEXT_INPUT_STALE)

The same command worked in a clean temp directory, in the app's demo workspace, in I-harness/docs, in a
git-initialized temp repository, and in trees with 3000 files, 3000 directories, or a junction.

## Root cause

Instructions are observed through fs-watch. The chokidar watcher was constructed with ignoreInitial: false, so it
emitted an add event for every existing file during the startup scan. The stream bounds its pre-consumer queue at
4096 events / 1 MiB and fails with FS_WATCH_GAP beyond that. The repository root has more than 4096 watched files
(packages, apps, installer staging, ...), so the watch route went unavailable, the instruction snapshot stayed
complete: false / reliability: unavailable, and the turn refused with CONTEXT_INPUT_STALE.

Instrumentation that located it:

    [diag] slot <root>/AGENTS.md reliability=unavailable presence=absent
    [diag] watch route unavailable roots=[<root>, <root>/.git, ...] error=Watch event buffer exceeded

## Fix

createFsWatcher now constructs chokidar with ignoreInitial: true. The pre-existing tree is already captured by
baselineWalk, so those startup add events were redundant; changes after readiness are still delivered.

## Verification

* fs-watch suite 69/69; new regression watch.test.ts creates 4200 files, expects ready and a later add;
* instructions 141/141; host-write-first, host-auto-title, host-legacy-fork-continue 4/4;
* CLI run in the repository root returns root-ok after the fix (it failed before it).