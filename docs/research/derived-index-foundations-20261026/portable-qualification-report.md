# Foundations fix1 — IF15 portable explicit qualification

Status: **verified tooling correction, ready for scoped independent review**. BASE is reviewed foundations commit `63825004a6a53d686e0955a771e27274d3b14c68`. The root-mandated integration portability gap is corrected; this is not a native probe/gate behavior change or a claim that Task2/full-budget work is accepted.

Sole writing checkout: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, branch `codex/derived-index-foundations-20261025`. Evidence: `D:/I-harness-main/.superpowers/sdd/2026-10-25-derived-index-foundations/task-1/fix1-if15/`. Binding root packet: IF15, MAIN `ca2c1aa5`.

## Connected tooling changes

- Rename ordinary `test/legacy-index-native.test.ts` to `test/qualification/legacy-index-native.qualification.ts`; adjust only its two relative imports and provenance comments. Native assertions/control behavior remain unchanged. The native probe, gate and gate tests are byte/hash-stable in the HOST worktree and have unchanged Git blobs.
- Add `test/qualification/vitest.config.mts`, which explicitly includes only the qualification file. Its filename does not match ordinary Vitest test/spec discovery. The normal package test command remains unchanged.
- Add `scripts/qualify-index-native.mjs` and package command `qualify:index-native`. The launcher requires explicit absolute `--active-node`, `--floor-node`, `--out`; output must not exist, and its parent must exist. It validates both original official executable checksums and every raw proof fixture before starting Vitest/native children. Missing/unmatched inputs refuse with exit2 before output creation or child launch. No download/install, profile/PATH/global setting, fallback or environment-supplied runtime path exists.
- Bundle the reviewed source arguments/policy, full reviewed observation extractions and original official checksum texts in eleven fixtures. Original implementation-source URLs/digests and new portable argument-file digests are separate. Portable copies explicitly label their representation, original artifact hash, rewritten evidence links and new bytes; no argument file is claimed to be a raw Node/SQLite implementation blob. Full observation data (~520KB) is preserved as root requested, rather than reduced to summaries.
- Add a narrow `.gitattributes` `-text` rule for the fixture directory. All eleven fixture working/index/fresh-checkout raw hashes are identical; original official checksum texts remain byte-identical to their original downloaded texts. Other Windows text conversion remains unchanged.

The launcher resolves bundle links relative to its fixture manifest and materializes only output-local absolute paths in the runtime qualification JSON. The unchanged native probe therefore verifies the portable reviewed argument/observation artifacts by their new hashes. Source-argument fields explicitly identify argument documents; each carries the exact original official source URLs and original raw source hashes separately. Historical receipts/Git review references are provenance, not command inputs. The command remains mandatory in the later fixed-version native qualification plan.

## Verification evidence

1. **Ordinary discovery without proof environment:** removed every `IH_DERIVED*` variable, then ran from the actual proof copy:

   ```text
   pnpm exec vitest list --filesOnly --json --exclude test/legacy-fork-scale.test.ts
   ```

   Exit0;35 ordinary files listed; qualification file absent. This is discovery only, not a broad package test run and not a native qualification PASS. Gate, full-budget, old callback-crash and scale tests were not executed.

2. **Explicit preflight refusals:** invoke copied launcher without arguments, and with the active executable incorrectly supplied as the floor executable. Both exit2; expected input/checksum error retained; no output directory created. Static ordering plus the refusal receipt demonstrates that those branches precede Vitest/native spawn. No child-process interceptor/trace was invented.

3. **Exactly one positive portable native qualification:**

   ```text
   pnpm qualify:index-native --active-node "C:/Program Files/nodejs/node.exe" --floor-node "D:/frontend-test/derived-index-native-if15-copy-e8b22347-46ae-444c-9bd0-58134809a6ae-runtime/node-v22.18.0.exe" --out "D:/frontend-test/derived-index-native-if15-copy-e381c683-a11b-4dbe-8ed0-931ced006d94-qualification-output"
   ```

   CWD: `D:/frontend-test/derived-index-native-if15-copy-e381c683-a11b-4dbe-8ed0-931ced006d94/packages/context-output`.

   Exit0; qualification file2/2 passed (18.73seconds), exercising the unchanged fourteen native controls across both pinned runtimes. No positive qualification rerun occurred. The copied floor executable was independently SHA256-checked and is outside the author evidence tree; both runtime inputs match the original official checksum texts before execution.

4. **Package typecheck:** `pnpm typecheck` in HOST package CWD, fresh isolated IH roots, all derived variables absent; exit0.

The proof copy was produced from staged tracked files via checkout-index, excluding every `.superpowers/` path, with no `.git` metadata/history and an existing-dependency junction only. The copy has neither directory. A first preparation copy revealed tracked `.superpowers` files; it was rejected before any positive native execution. Its preparation receipt remains, and the actual proof copy was built without those files. No destructive cleanup was needed.

## Raw receipts and limits

- `fresh-copy.json`: actual proof copy, explicit excluded prefix, dependency/runtime locations, all eleven fixture working/index/checkout byte comparisons.
- `ordinary-discovery-command.json`, `ordinary-discovery.json`: environment absence, exact command and ordinary file list.
- `missing-inputs.json`, `mismatched-floor.json`: raw negative argv/status/stdout/stderr and no-output observation.
- `explicit-qualified-command.json`, `explicit-qualified-output.txt`, `explicit-qualified-result.json`: exact one-run command, native GREEN output and status.
- `portable-launcher-receipt.json`: copied launcher's argv/environment/source/fixture identities and exit; original full native receipts remain under the recorded fresh output directory.
- `official-checksum-raw-byte-proof.json`, `source-manifest.json`, `unchanged-behavior-manifest.json`: original versus portable hashes, raw-byte identities and unchanged native/gate/product scope.
- `typecheck.txt`, `typecheck-result.json`, `verification-summary.json`: scoped final verification.

The explicit native command still qualifies only the reviewed Windows x64 runtime/SQL/VFS conditions. Ordinary discovery exclusion never substitutes for it. The reviewed source-argument, compiler-clone, native temp observation, failure and product-adoption limitations remain unchanged. No new total-memory/transient-I/O or authoritative Store lifecycle claim is added. No Store/service/schema/public DTO/index-export change, broad ContextOutput/Gateway/full-budget/1001/10001 run, provider traffic or global/package installation occurred. The only package manifest edit is the authorized local qualification script; the lockfile is unchanged.

The protected `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains unread/unrun/untouched and is not copied because it is untracked. Only its pathname appears in Git status. Native probe, gate and original source files have no diff from BASE. Commit/range receipt follows below. Scoped reviewer checks remain required before integration; no next connected implementation task started.

## Final commit/range receipt

Commit: 6689aa951669779e37599b6d819429a6a7ad1e3f (test: make pinned native qualification explicit and portable).
Exact fix1 range: 63825004a6a53d686e0955a771e27274d3b14c68..6689aa951669779e37599b6d819429a6a7ad1e3f.
Sixteen necessary IF15 paths changed, including the96% native-file rename and eleven explicitly raw/hash-bound proof/checksum fixtures. Native probe/gate/product sources and lockfile are unchanged. Tracked working tree clean; sole untracked pathname is the protected preexisting Gateway test.
Source raw hashes still match the verified source after commit. Exactly one explicit positive portable qualification ran; no additional runtime/suite rerun followed.
Status READY_FOR_SCOPED_REVIEW. Root requested the same scoped reviewer before integration; no integration or Task2/full-budget acceptance claimed.
