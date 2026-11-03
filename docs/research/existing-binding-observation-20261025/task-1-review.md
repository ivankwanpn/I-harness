# Task 1 independent full-range review

Reviewed range: `d053cbde7eac352dc3b48d1bc9ad537d3e431ff1..fdaba3188235faee9def0ac80e0daf8a80dd87ad`.

Reviewed frozen checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`. Actual HEAD was `fdaba3188235faee9def0ac80e0daf8a80dd87ad`; tracked status was clean. Requirements were `task-1-brief.md`, including its exact API/shared-owner appendix, and `docs/superpowers/specs/2026-10-25-existing-binding-observation.md`. Review also consumed `task-1-report.md` and the supplied `review-d053cbde..fdaba318.diff` once. The changed source and new test file were read directly to cover the full range, including material beyond the tool's diff-output truncation.

**Spec verdict: PASS for this persistence-owner prerequisite.** No outstanding production-code requirement violation was found. This verdict does not accept public F1-C rollout or any production host reader.

**Code-quality verdict: APPROVE.** No actionable production-code defect was found in the connected range. One low-severity evidence-report correction is recorded below; it does not block integration of the reviewed code.

## Findings

- **[P3, nonblocking] Correct the missing artifact reference — `D:/I-harness-main/.superpowers/sdd/2026-10-25-existing-binding-observation/task-1-report.md:101`.** The report lists `diff-check.txt` among the frozen handoff artifacts, but `task-1/diff-check.txt` does not exist at the stated destination and is not an entry in `evidence-sha256.json`. Remove that artifact claim or create an accurately identified receipt. This reviewer independently ran `git -C C:/Users/inkik/.codex/worktrees/context-current/I-harness-main diff --check d053cbde7eac352dc3b48d1bc9ad537d3e431ff1 fdaba3188235faee9def0ac80e0daf8a80dd87ad`; it produced no diagnostics and exited 0. The gap is the report's artifact inventory, not a discovered whitespace defect or failed verification.

## Contract and lifecycle assessment

The changed-file list is exactly the three permitted persistence source files and the new `existing-binding-observation.test.ts`. There are no version/schema/other-owner/host changes. The new interfaces match the brief, are exported by the package, and the optional method is actually wired through `createSessionCoordinator` under the unchanged F0 lock/strict-read/Windows-or-Linux facade gate (`src/index.ts:20,59`). There is no unlocked or tolerant-read fallback.

`binding-observation.ts:127–148` closes the new request before acquisition using own data descriptors, rejects request/array proxies before inspecting caller traps, rejects accessors/unknown/symbol/nonenumerable/undefined fields and nonplain/sparse/extra arrays, copies 1..64 distinct safe IDs, validates the intrinsic AbortSignal brand, and validates the callback. Sorting and iteration operate on the internal copy. The request and read scope have no target or invocation.

The scope union and shared `observe` engine use the original indexes, AsyncLocalStorage stack, native session claims/document leases, admission and disposal paths. Registration precedes the first acquisition await. Sorted session pins precede sorted derived binding leases. Each successful late acquisition is pushed into the scope before the after-await guard. Every requested existing ID receives an actual backend profile in a short session lane; identity/archive checks and immutable strict JSON capture precede callback entry. The binding path reads only derived keys through `readDocumentObserved`, with before/after guards. It does not call ordinary `getDocument` or read metadata from a managed header (`binding-observation.ts:177–244`).

Self-overlap and mutation checks use the complete nested stack before pending admission. Metadata/document mutations, deletion, retirement and close share the original synchronous revocation and whole-lifetime joins. Permanent scope retirement prevents metadata/binding ABA from restoring old authority. Read scopes cannot enter the bootstrap allowed list: only `kind:'fork'` reaches the exact original invocation comparison (`binding-observation.ts:44–57`). Both self-bootstrap/resume refusal and external bootstrap/resume join are exercised with actual B2 requests, while the disjoint mixed-scope test preserves the original fork exception.

Cleanup retires synchronously, releases document leases before temporary claims, attempts independent disposers, keeps failed original handles, and includes cleanup in scope completion. The unchanged ownership layer still distinguishes live owners from temporary claims and preserves consumed-native uncertainty instead of treating a later no-op as proof. The new diagnostic branch carries frozen captured session IDs without an invocation. `callbackPending` preserves an existing-read callback's literal thrown value after revocation while a returned success still encounters the final guard; the fork branch retains its previous error-normalization rule (`binding-observation.ts:245–264`). The active-abort original-error test and native-failure tests substantiate these distinctions.

The E17 test admits an actual managed metadata fact and observes an increased event count while the read guard remains current. This correctly demonstrates the non-freeze boundary. The implementation does not establish READY, managed-view freshness, project/broker/host/Stop authority, local/anchor visibility, predicate/body guards, or a host adapter.

## Verification and evidence reviewed

No runtime, provider, host build, or test suite was executed by this reviewer. No unaddressed runtime risk requiring a rerun was identified. Verification below is inspection of the source-bound raw receipts, not a claim of an independent test execution.

| Receipt in `task-1/` | Verified outcome |
|---|---|
| `13-isolated-focused.txt` | Source `fdaba318…`, actual persistence package CWD, explicit isolated `IH_CONFIG_DIR`, required worker flags, 50 new plus 56 original tests, 106/106, exit 0 |
| `14-isolated-persistence-regressions.txt` | Same source/isolation, required five affected files, 39/39, exit 0 |
| `15-isolated-persistence-typecheck.txt` | Same source/isolation, `pnpm typecheck`, exit 0 |
| `16-isolated-jsonl-regressions.txt` | Same source/isolation, actual JSONL package CWD, required four files, 100/100, exit 0 |
| `17-isolated-jsonl-typecheck.txt` | Same source/isolation, `pnpm typecheck`, exit 0 |

The final receipts show 245/245 tests and both package typechecks passing after the recorded config-isolation correction. Their SHA256 values match `evidence-sha256.json`. The six allowlisted live source/test SHA256 values match `source-sha256.json`; original F0 tests have the identical Git blob at BASE and HEAD (`7d12e3b7986a7b87a3dabd25f305d96262332ff6`). Thus the unchanged original 56-test population is supported by both source identity and final output, rather than only an aggregate test count.

The focused raw output contains the E01 128 real acquisitions, all eight E08 cut counters with acquired=released=cut and live/callbacks=0, E14 same-handle retry counts, and E15 consumed-held=false/dependent-held=true debt counts. The new tests wrap the actual native acquire/release implementation and use actual backend files/effects. The preserved `05-callback-revocation-semantic-red.txt` contains the causal original-error identity failure; it is distinct from the reported missing-capability and test-typing setup failures. Its hash also matches the manifest.

## Bounded checks outside the changed range

These were targeted source/evidence reads for concrete shared-owner risks, not a repository crawl:

- **Persistent-owner and cleanup-debt safety:** `src/coordinator/ownership.ts` claim retention, exact slot identity/debt guards, release single-flight and consumed-native failure handling. These are the actual resources reached by the common engine.
- **Mutation bypass/self-deadlock:** the `metadataMutation` seam in `mutations.ts`, strict/ordinary binding-write admission in `documents.ts`, and owned deletion in `lifecycle.ts`. They all consume the same observation owner; ordinary self-write refusal is outside its reporting catch, and deletion joins before native tombstone/removal/listener work.
- **Retirement and close safety:** the facade's retirement wrapper, load/open/profile refusal, and close path in `src/index.ts`. Unresolved observation cleanup prevents dependent managed ownership release while independent lifecycle drainage remains available.
- **Strict-read evidence:** unchanged `session-persistence-jsonl/test/document-observed-read.test.ts` contains actual absent/present/malformed controls, EACCES/EIO faults, missing/inaccessible root and post-read tombstone checks; its six-test result is present in the final JSONL receipt.
- **Original exception preservation:** named original F0 target-only, exact-invocation, unknown recovery/join/resume, ancestor external bootstrap and capture controls remain present; original test identity is unchanged. Static Git name/status/blob/hash checks and the independent diff whitespace check bound the reviewed source.

## Evidence limits and integration boundary

The final native/test qualification is Windows-only. The Linux branch remains advertised under the existing capability condition, but no Linux execution was supplied or claimed. Historical pre-isolation runs remain historical evidence; the final isolated receipts supersede them for acceptance. The missing `diff-check.txt` reference is the sole report correction found.

The protected `.task3-evidence/` was not read, run, enumerated or changed. No product file was edited by this review. Root retains responsibility for integration and any downstream integrated-source checks. Public fork DTOs/callers, production strict host readers, managed view witnesses, READY/project authority, ContextOutput visibility adapters and the remaining F1-C work are outside this approval.
