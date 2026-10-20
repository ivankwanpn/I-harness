# R4A owned Session version qualification delivery

The original JSONL backend and persistence coordinator now have actual owned-open, metadata-append, full-close and fresh-coordinator reopen qualification for literal Session8/9 → current10 and current10 retained results. This is a tests-only delivery. No production defect or production fix is claimed.

Implementation BASE is `538cdb9297bbf6c4f757dfd69d3a48239032e4b8`; implementation HEAD is `cdb55a4ba4aa704956ab1a0296c1bbdb71b1e2c3` on `codex/v0.1.13-development`. The separate delivery-document commit and final handback HEAD are recorded after commit in `.tmp/context-r4a-owned-version-20261020-implementation/final-seal.json`. Root's separate planning changes are excluded from the implementation commit.

## Qualified behavior

- Literal8 and literal9 each run explicit backend header upgrade and automatic upgrade through real ownership. Cold snapshot preserves the source; upgrade preserves the exact original body and complete header metadata except `formatVersion`; one real managed title record commits; a new backend/coordinator reopens the same disk file after ownership has fully released.
- The predecessor controls preserve original generation reservations with no new disposition, the old result reference, unknown extension/model-selection fields, and a separately qualified historical `TOOL_OUTCOME_UNKNOWN` result with `replay:false` and no invented retained envelope. The original literal8 fixture remains unchanged. Opening and reopening add no execution/child facts and make zero fetch calls.
- Each retained slot has its own valid framed current10 counterpart that survives owned append and fresh reopen: ordinary `tool/result`, nested `code/result`, emitted `code/output`, `subagent/end` envelope plus revision, and `job/status` retained revision. Exact event equality preserves execution, ref/revision, completeness, media and dependency metadata.
- Each valid counterpart is rewritten only at the header to literal8, literal9 and future11. Real owned entry refuses it with the original version-validation error; source bytes remain exact. Delegating spies show zero calls to repair, upgrade, replacement, legacy append, managed journal read/truncation, owned append or reconciliation, including after close. Failed acquisition is released.
- Existing cold-snapshot, held/rejected-upgrade pending-batch, framed literal6 Unicode/CRLF bytes, metadata extension, uncertain append, fenced recovery, callback order and Windows lease assertions remain in place.

The new cases are characterization/qualification on unchanged production code. Obsolete assertions and fixtures are test-contract migration. Neither category is presented as meaningful product RED or a newly fixed product regression.

## Exact implementation files

```text
packages/session-persistence-jsonl/test/context-format.test.ts
packages/session-persistence-jsonl/test/format8-predecessor.test.ts
packages/session-persistence-jsonl/test/generation-reservations.test.ts
packages/session-persistence-jsonl/test/jsonl.test.ts
packages/session-persistence-jsonl/test/replacement-journal.test.ts
packages/session-persistence-jsonl/test/retained-format-ownership.test.ts
packages/session-persistence/test/attribution-format4.test.ts
packages/session-persistence/test/conversation-format.test.ts
packages/session-persistence/test/coordinator-order.test.ts
packages/session-persistence/test/fork.test.ts
packages/session-persistence/test/native-witness-format5.test.ts
packages/session-persistence/test/ownership.test.ts
packages/session-persistence/test/persistence.test.ts
```

Root ruling VERSION-01 authorized the eight additional same-owner files exposed by full package runs. Their changes target fixtures intended to describe a current writer and current-result assertions. In particular, callback-order's repaired result now uses current10 because its purpose is missing-sequence canonicalization/late receiver lookup; no fake upgrade capability or increased timeout was introduced. Literal old-wire fixtures, future99, unrelated generation total-cap9 and original safety assertions remain intact.

## Final sequential evidence

Raw evidence is `.tmp/context-r4a-owned-version-20261020-implementation/`. Every numbered run records executable, arguments, cwd, start/end, exit, stdout/stderr, and complete source manifests before/after. The final package gates/types/build/copy share frozen product/test/source digest `c66dc6831267156a2f9dda9974f4d35e0bc1622b5491ca532443aeb4b62dcc43`.

| Receipt | Result |
| --- | --- |
| 02–05 | Original four-file stale-oracle baseline: 10 failures; no source changes during runs |
| 14–15 | Sequential expanded baseline: JSONL 12 stale failures; persistence 12 stale failures and one upgrade-capability unhandled rejection; saved before VERSION-01 corrections |
| 20-jsonl-full-final | 15 files, 146 tests passed |
| 21-persistence-full-final | 26 files, 153 tests passed, no unhandled errors |
| 22-types-jsonl-final | `tsc --noEmit -p packages/session-persistence-jsonl/tsconfig.json`, exit0 |
| 23-types-persistence-final | `tsc --noEmit -p packages/session-persistence/tsconfig.json`, exit0 |
| 24-gateway-final-build | Actual Gateway copy builder, 242 shipped packages, exit0 |
| 27-copy-runtime-config-corrected | Copied public original owners: 24 tests passed |
| 28-copy-map-final | Gateway CLI plus 77 other internal packages: 1,141 source-identical payload files, 322 copied-root internal edges; generated WSL manifest separate |
| 29–31 | Working/staged whitespace checks and coherent test commit, exit0 |

The JSONL full suite deliberately prints the existing injected file-close cleanup diagnostic from `fact-batch-journal.test.ts`; its test passes and the receipt retains stderr. The build prints unavailable optional packages for other platforms. These are not silently described as empty output.

Non-qualifying/setup evidence is retained: receipt01 accidentally matched historical `.tmp` tests because the initial Vitest root was too broad; receipts12/13 briefly overlapped and were superseded by explicit-wait sequential runs14/15 then final20/21. Receipt06 incorrectly assumed the decoder's in-memory version stayed at the predecessor and that result validation used the conversation error wrapper; receipt07 had an incorrect generation-state shape assertion. Receipt10 caught a test fixture header type error. Receipt19 assumed a generated WSL manifest had a source-identical counterpart; receipt26 used an incorrectly relative Vitest config path. These are harness/test-authoring failures, with no product regression claim, and all were corrected before final qualification.

## Copied original-owner route

Fresh candidate: `.tmp/context-r4a-owned-version-20261020-gateway-final/`. The normal `packages/desktop/scripts/build-gateway.mjs --out ...` copied source owners. `copy-map.json` records every source/copy SHA256 and actual internal package entry resolution; all internal edges resolve inside the copy. The Gateway CLI payload is included. The generated `sandbox-wsl/worker/manifest.json` has its own output SHA256 and provenance `scripts/runtime-wsl-assets.mjs:copyWslAssets`, tied to the original worker source.

The exact test/fixture changes for copied execution are in `fixture-transformation-map.json`:

1. Qualification test backend import `../src/index.ts` → `@i-harness/session-persistence-jsonl`.
2. Qualification test literal8 fixture import `../../core-session/test/fixtures/format8-journal.ts` → `./format8-journal.ts`.
3. Copied literal8 fixture core import `../../src/index.ts` → `@i-harness/core-session`.

All assertions and fixture bodies remain identical. The Vitest framework is workspace tooling; the exercised core-session, persistence, JSONL, settings/fs-lock dependencies and their internal owners resolve through copied packages. The final receipt uses an absolute config path and package-scoped root. Source/copy identities and fixture transformations are rechecked at the final seal; evidence inventory hashes are saved in `evidence-inventory.json`.

## Limits and handback

No test failure remains in the two affected package suites or types. This qualifies library/backend/coordinator behavior in an isolated Gateway package copy. It does not claim packaged IPC, installer, CLI release, live provider, installed user profile/account, 100MiB fan-in or whole-R4A qualification. Product `0.1.13-rc.1`, Session10 and decomposition27/43 are unchanged. No push, merge, tag or release occurred.

After the final seal, implementation writes are frozen for fresh independent review. Final seal records the handback HEAD, tested source digest, exact copy/fixture hash checks, evidence inventory and task-process snapshot. Root continues with native producer outcomes and explicitly authorized artifact paging after independent acceptance.
