# W2 settings review correction 2 — fixture portability

Status: test-only portability correction committed; ready for the same reviewer's final recheck. The original product finding was closed by review-fix1.md and is unchanged here.

- Base: `7ad871f15a32260311abe99da123d75b09a8b99e`.
- Commit: `1ca5385621489e24d551d2201baf99df8459ca0c` — `test(settings): keep relative workspace fixtures on checkout volume`.
- Branch/worktree: `codex/settings-watch-consumer-20261024`, `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Only repository file changed: `packages/settings/test/watch-baseline.test.ts`.

## Correction

The two workspace-auto-source rows now create unique mkdtemp roots beneath `resolve(process.cwd(), ".tmp")`. They assert the root and package CWD have the same volume/root, the fixture is directly under the expected temporary parent, and the relative path is non-absolute. The existing relative/absolute assertions, exact read/publication→acquisition write boundary, initial reset, effective value, source spelling, and callback spelling assertions remain intact.

Each store closes in its inner finally. The outer finally resolves both fixture root and temporary parent with realpath, requires dirname(actualRoot) === actualParent, then recursively removes only that exact fixture root. The shared .tmp parent is not deleted. A post-run inventory found zero ih-workspace-baseline-* directories. Other fixture helpers and files were not changed.

An explicit Windows cross-drive control uses node:path.win32 and fixed synthetic path strings, without accessing MAIN or either synthetic path. From D:/checkout/packages/settings, the old C:/Temp fixture produces an absolute destination; the package-local D: .tmp fixture produces a relative destination and has the same volume root. The runnable control is saved as fix2-crossdrive.cjs; its exact invocation/result/exit are in fix2-crossdrive.log. No MAIN D: runtime was started.

## Bounded verification

| Gate | Result | Raw receipt |
|---|---|---|
| Windows cross-drive and same-volume construction control | Both assertions pass, exit 0 | fix2-crossdrive.log + fix2-crossdrive.cjs |
| Two affected workspace-auto-source rows | 2 passed, 6 unrelated skipped; exit 0 | fix2-cases.log |
| Settings typecheck | no diagnostics, explicit exit 0 | fix2-typecheck.log |
| Final selected source/Git hashes before/after tests | Identical | fix2-final-before.txt, fix2-final-after.txt |
| Working/staged diff check | exit 0 | tool transcript |
| Owned fixture post-run inventory | zero remaining matching directories | tool transcript |

The exact tests command was `pnpm exec vitest run test/watch-baseline.test.ts -t "workspace auto source" --maxWorkers=2 --minWorkers=1`; CWD was the HOST packages/settings directory. `pnpm typecheck` ran sequentially from that same directory. Each raw command log embeds its CWD, command, and numeric exit marker. No product code changed, so the previous 60/60 affected watcher/layering qualification is reused as requested rather than rerun.

`fix2-start-binding.txt` records pre-edit HEAD/status plus original test source, product layered-store source and protected diagnostic hashes. Final binding files additionally include the patched native handler and are byte-identical across verification. The original 9094 and 7ad871 commits and every earlier receipt remain intact. These are selected bindings, not a whole-runtime or release attestation.

Postcommit status contains only the original untracked/unstaged gateway diagnostic. No production source, single-store behavior/test, manifest, lockfile, version, W1/native handler, gateway source, shared helper, or other repository file changed. No merge/push/tag/release action. Runtime is released for same-reviewer recheck.
