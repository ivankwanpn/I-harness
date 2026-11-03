# R4A surface retirement — accepted-source rebase

2026-10-21. **PASS: the amended bounded plan is source-ready on accepted HEAD `c1b1a8d7dfcb2bd47fb0413b1a022a18d8d15eeb`.** This note is a read-only source/design rebase, not a product implementation or runtime qualification. Canonical plan promotion and the later documentation checkpoint for writer BASE remain root-owned.

## Accepted predecessor and identities

* Current HEAD was read as `c1b1a8d7dfcb2bd47fb0413b1a022a18d8d15eeb`.
* Canonical structural acceptance: `docs/research/2026-10-21-context-r4a-structure-acceptance.md`. Its accepted structural range is `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994..ae56ce0996e4cc5f9738c798d200b89ee5032f0e`; repair code is `f7086d8acbf6febb5724688408d597beabae1d03`. The root acceptance records same-reviewer P2 closure and independent audit/census; this preflight does not claim to have rerun them.
* Entire amended local draft read: `.superpowers/sdd/2026-10-21-context-r4a-surface/plan-draft.md`, SHA256 `092e4de6aa6841ee8149eedd146366754a9b8eeb5bf6386258654d4d21365bfd`.
* Original source findings and five amendment closures: `preflight-review.md`, including its appended scoped re-review.
* Read-only Git comparison showed `ae56ce09..c1b1a8d7` changes only documentation/evidence. Scoped product/manifest/lock worktree diff was empty; scoped nonignored untracked owner/consumer inventory was empty. This is not an exhaustive hidden/ignored source seal; the writer must capture its actual complete input manifest before gates.

## Workspace timing repair and unchanged retirement boundary

The accepted fix changes the private legacy capture port from scalar `workspaceId` to `getWorkspaceId: () => string` (`packages/context-output/src/legacy/capture.ts:8`). The service passes the live getter at `service.ts:128`, and capture reads it separately for reference ID and reference workspace at `legacy/capture.ts:33–34`, after the original producer/store awaits. It preserves the accepted mutable options/timing policy. It introduces no registry guard mount, public export, store, new source authority or test-retention contract. Do not undo or resnapshot this getter as part of surface retirement.

Source recheck confirms these original dispositions remain valid:

| Surface/responsibility | Accepted-source observation and bounded action |
| --- | --- |
| Four named record/options types | `core-session/src/index.ts:101–102` and `output-retention/src/index.ts:227–228` still expose `JsonStreamOptions`, `ExecFrameRecord`, `ResultCaptureOptions`, `ExecFrameCaptureOptions`; defining types remain used locally by real codecs/factories. Remove only unused named reexports/localize after recheck; keep shapes and behavior. Both package manifests still declare `private:true` at line4. |
| Envelope validator | `core-session/src/index.ts:99` still reexports `validResultEnvelope`; its real internal calls remain at `results/validate.ts:85,101`. Gateway's authority test remains the external named test consumer at `desktop-gateway/test/desktop-child-authority-host.test.ts:13,76–82`. Retire the root name and preserve internal validation; migrate the genuine DTO test through the amended public intake path. |
| Registry guard/GC/unified adapter | `output-retention/src/spill-guard.ts:205,211,294,325` and barrel `src/index.ts:225–226` are unchanged. Maintained factory calls remain old test invocations; no shipping mount/new independent GC consumer appeared. Retire the dead responsibility coherently. |
| Inert `outputSpill` plumbing | Same type/import/assignment edges remain in executor assembly/service, CLI run/SDK/ACP and Gateway host. No maintained settings/parser/plugin installation consumer appeared. Existing assembly still acquires the result owner and installs mandatory `createToolResultRetention` independently at `session-executor/src/assembly.ts:557–560`; native retention remains at line736. |
| Live shell/native fallback | `shell/src/tools/retention.ts:2,11–14,51–65` still consumes retainer/store/notice and preserves existing stdout spill path before optional fallback. Its live API/test, native collector/frame/outcome and historical raw/path contracts remain outside the deletion. |
| Test migration/setup | Gateway exact observations, required-policy mock/raw2,000-byte service fixtures, direct old synthetic cascade, invalid new-media fixture, raw timeout exemption, copied estimator and `events.push` historical-read assumption are unchanged. The amended case and obligation maps remain applicable. None was executed or newly classified as a reproduced failure here. |
| Production/test dependencies | output-retention still needs core-session/core-tools/context-output/exec; old guard/tests still account for core-plugin/diagnostics. Existing undeclared deep test edges still need the planned explicit destination/dependency disposition. Normal manifests/lock importer changes are permitted for actual needs; no private production import, allowlist/baseline edit or fake consumer. |

Historical release/build/worktree copies are reference material, not maintained callers. Leave them and old spill/evidence files unchanged. Preserve actual legacy readers/renderer branches, literal8/9 compatibility and all exact caller/program values separately from bounded F1/model envelopes.

## Execution handoff scope

No source-readiness blocker remains after all five amendments. This does not remove the writer's obligation to inspect the final promoted BASE, inventory every affected case, validate actual same-executable pre-import `TEMP`/`TMP`/`IH_CONFIG_DIR` containment, and record genuine source-stable tests/types/normal graph results. The ordinary64,000 serialized-byte bound, trusted outcome, no-replay, source/generation/F1 ownership, media and truthful unavailable contracts remain unchanged. Retired guard-only tests must be honestly mapped rather than reported as passing current behavior.

Only `preflight-review.md` (append) and this note were written. No product/test edits, runtime imports, test/build/audit gates, GC, old tmp/config enumeration or cleanup, Git mutations or new agents occurred. Product `0.1.13-rc.1`, Session10 and whole-R4A/decomposition/release boundaries remain as accepted by root. The inherited six-export graph remains open; final A6 large-data/copied/bundled qualification follows implementation, independent review and root acceptance.
