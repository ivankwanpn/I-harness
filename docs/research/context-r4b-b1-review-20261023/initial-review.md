# Independent B1 specification and quality review — 2026-10-23

**Verdict: REQUEST CHANGES. Specification acceptance is withheld; quality acceptance is withheld.** One P1 compatibility regression and six P2 boundary/test defects remain in the reviewed source. This is a B1 staging review, not acceptance of B2, B3, shipping inheritance or whole B.

Reviewed range: `0fb20ee93124cfb40f71205feaf0f4a5bd747257..bf4c0aa5b24f3755d8d0e685fd161b57e6133a27`. Product commit: `886045296831cb1aea438f4d1a0999dd27efe5d3`; the later commit records root rulings. Current line numbers below refer to HEAD `bf4c0aa5`. Checkout: `D:/I-harness-main`.

This resumes the interrupted independent review; it does not inherit an acceptance from that reviewer. All five saved partial observations are preserved below and now have dispositions. I read the resume, task brief/review brief, report/contracts, the generated range diff, canonical root decisions and relevant implementation/tests/callers. I performed static reads only: no product execution, suites, index or Git mutations, product/test edits or recursive agents. The only reviewer write is this report. The separate designated runtime owner executed the requested focused probes on unchanged source; their scripts, logs and receipts were then reviewed here.

## Actionable findings

### F1 — [P1] Admit the immediate format 10 predecessor to the writable migration barrier

**Location:** `packages/session-persistence-jsonl/src/index.ts:222`.

The public `upgradeSessionFormat` guard allows expected versions `1..9` or `target`. With the new target equal to 11, format 10 is omitted. The underlying `backend/format-upgrade.ts:28` explicitly supports format 10, but every caller is rejected before reaching it. Consequently an ordinary existing format 10 session can be read/snapshotted, but cannot be opened for managed continuation, made writable, or updated through the coordinator. This affects the immediate existing source format, not just malformed seed data.

**Execution evidence:** probe E provisions a valid literal format 10 journal containing a closed turn and input, validates it with the actual backend reader and projection, and successfully snapshots it. Direct `backend.upgradeSessionFormat(id,10,11)`, `coordinator.ensureWritableFormat`, `coordinator.openManagedDocument` and `coordinator.updateMeta` all reject with `unexpected session format upgrade or downgrade` at line 222. The managed metadata admission is never reached. Every file remains byte-identical and version 10. A genuine current 11 managed metadata control commits `plan/mode`. These are behavioral failures, not setup failures.

**Contract:** B1.2 requires current 10 compatibility and preservation of old semantics during the owned upgrade. The new `format11-predecessor.test.ts:91` control only loads an empty old session; a successful read does not qualify its writable barrier. Existing retained-format migration tests cover 8 and 9 but omit 10.

**Required correction:** include supported format 10 in the existing public migration admission, preserving the header-only migration and original journal/body bytes. Add a maintained actual format 10 owned reopen/admission/close/fresh-reopen control, plus direct upgrade if retaining that public seam. Do not invent a semantic readiness certificate for the old session. Verify metadata and generation/result observations survive the upgrade and reject future/downgrade requests as before.

### F2 — [P2] Capture selected text by descriptor before rendering it

**Location:** `packages/core-session/src/conversation/render-items.ts:37` (also summary text at line 41 and assistant text at line 58).

The exporter supplies `captureSelectedData` to the shared renderer, but input, summary and assistant text bypass `readConversationPayload` and are read directly from `event.text`. A selected `user/message.text` accessor therefore executes before closed-data validation. Its returned value is inserted into the rendered message, so validating the resulting seed cannot detect the source accessor: the invalid source is accepted and its computed value is hashed and exported.

**Execution evidence:** A1 first exports the unmodified real source successfully. It then replaces only selected `text` with an enumerable getter returning `getter text`. `exportConversationSeed(...,all)` returns `kind:'seed'`, the getter counter is 1, and the emitted message content is `getter text`.

**Contract:** B1 requires selected closed own data to reject accessors before reads/publication and one owned selected capture. R-B-10 allows discarded payload exclusion; it does not authorize evaluating selected accessors. This is separate from F3: the renderer needs the payload capture port even after structural scalar validation is repaired.

**Required correction:** route selected text slots through the existing descriptor-aware capture port when capture is requested, including the summary and assistant variants. Keep normal raw rendering semantics and discarded-text exclusion. Add real-source controls that return benign strings from selected text getters, assert refusal and zero reads, and preserve a consumed-text getter control proving no whole-archive preflight was introduced. A getter that merely throws is an insufficient sole control because catch/refusal can hide its execution.

### F3 — [P2] Reject structural scalar accessors before the shared source index reads them

**Location:** `packages/core-session/src/events/conversation.ts:50` (source profile entry); the new boundary reader also directly reads them at `packages/core-session/src/conversation/seed-selection.ts:17`.

The package-private source profile validates special seed/envelope metadata, but ordinary event structural scalar descriptors are not preflighted before the history/index/generation passes read them. For example, `turn/start.seq` reaches `historyFact`, source-address construction and `sourceTurns` as an ordinary property read. It can execute repeatedly and still produce an accepted export. Calling the source index before `resolveSeedBoundary` does not implement R-B-15 unless that source index actually rejects these descriptors first.

**Execution evidence:** A2 uses the same supported real source and changes `turn/start.seq` to an enumerable getter returning its original value 0. Export returns `kind:'seed'`; the getter counter is **19**. No malformed new event or missing import is involved.

**Contract:** R-B-15 explicitly requires descriptor/scalar validation before boundary/scalar reads while retaining R-B-10's payload exclusions. Current tests exercise an envelope `execution` accessor, which does not cover ordinary sequence metadata.

**Required correction:** add narrow descriptor-safe structural metadata validation in the same source shape/history owner, before discriminant, sequence and other structural fields are dereferenced. Keep discarded text/value/native/image bodies opaque and preserve strict public validators. Add actual ordinary seq/type/turn metadata accessor counters and verify zero reads/refusal, alongside existing consumed-envelope/seed traps. Do not solve this with full-source `seedData`, clone or stringify.

### F4 — [P2] Validate seed/bootstrap invariants before public JSONL publication

**Location:** `packages/session-persistence-jsonl/src/index.ts:117`–`118` (candidate suffix is addressed and encoded without candidate-history validation; individual shape validation is at line 102).

`append` fully reads/validates the existing journal but only validates each candidate event's individual shape. A well-shaped manifest without a reservation, or a well-shaped extra seed group after completion, is consequently written and synced successfully. The next normal backend read rejects the new history. This turns an initially readable session into a durable invalid session despite successful append completion; later strict reading does not undo the publication.

**Execution evidence:** B1 creates a genuine plain current 11 backend file with no seed reservation, verifies it reads/projects, then appends the literal manifest. Append resolves, bytes change **252 → 1062**, and the next backend read rejects `Invalid semantic seed`. B2 provisions and reads the complete literal ready fixture through the real backend, then appends an extra literal group at seq 3. Append resolves, bytes change **2873 → 4345**, and the next read rejects the out-of-prefix seed record. Reads themselves do not modify bytes. Before/after files and hashes are retained.

**Root contract ruling received 2026-10-23:** the task contracts at lines 348/354 cover public JSONL `backend.append` for the new semantic seed/bootstrap publication invariants. B1 must reject orphan, out-of-prefix and partial-invalid candidate seed/bootstrap states before changing bytes. Root explicitly limits this to the shared bootstrap readiness/shape validation on candidate history in the existing public method; legacy raw append contracts and private owned-batch growing-prefix staging must remain intact. This is a confirmed actionable P2, not an unresolved layer interpretation.

**Required correction:** validate the new seed/bootstrap candidate history against the real loaded header/prefix before encoding/writing, using the same validation owner. Preserve the internal owned bootstrap staging route and do not grant ordinary append an incomplete-prefix bypass. Do not broaden all legacy cross-event semantics, create another validator/owner or use a cross-package private import. Root permits a narrow strict public core validator with this genuine backend consumer if needed; no exported skip-readiness capability is allowed. Add actual backend byte-identity controls for both rejected cases plus a valid ordinary append to a ready fixture. Do not claim rollback based only on the subsequent read's refusal.

The scoped public-writer addendum below extends this same finding to confirmed `replaceEvents` and reservation `updateMeta` publication failures, incorporating root R-B-16. It does not add another finding or change priority.

### F5 — [P2] Preflight the standalone installation slots before changing the target header

**Location:** `packages/core-session/src/managed/memory-bootstrap.ts:23`–`24` (pristine guard is lines 12–13).

Pristine/unbound/empty and `Object.isExtensible` do not guarantee that the existing `events` property is writable. The function assigns `header` first, then `events`. A fresh otherwise legal Session whose own `events` property is nonwritable passes the guard and all seed validation; the second assignment throws after the first mutation. The failure leaves a header-only reserved target, violating the advertised single atomic installation and preventing a pristine retry.

**Execution evidence:** C starts from actual `createSession`, changes its existing `events` data property's flags to `writable:false, enumerable:true, configurable:true`, and invokes bootstrap with the literal ready data and `current()=>true`. It throws `Cannot assign to read only property 'events'` at line 24. Before: no header, empty events. After: the semantic header is installed, original events identity remains and length is 0. No observer or hostile proxy is needed.

**Contract:** B1.2/R-B-08 requires synchronous header/events/index installation with no partially observable target. R-B-15's existing-owner check is correctly present but does not cover assignment failure.

**Required correction:** verify that all target installation slots can be safely installed before the first mutation, or use a prevalidated installation strategy appropriate to the supported ordinary Session object. Refuse unsupported descriptors with target header/events/index unchanged. Retain current guard, fresh/bound-empty discrimination, same index owner and observer ordering. Add this exact nonwritable-events control with identity/content checks; do not merely assert a thrown error.

### F6 — [P2] Enforce one dependency-catalog count for each immutable ref

**Location:** `packages/core-session/src/conversation/seed-codec.ts:222`–`228`; capture currently accumulates the contradictory uses at `seed-capture.ts:63`–`64`.

Artifact use validation compares sets of canonical use objects, so catalog uses `{count:1}` and `{count:2}` are treated as two valid distinct uses of the same immutable ref. No consistency check requires a single catalog count per ref. The exporter therefore accepts, hashes and validates contradictory cardinality observations in its exact dependency table, which is the handoff contract for later transfer.

**Execution evidence:** D uses two normal calls/results in one real closed step. Each actual ResultEnvelope independently passes the full existing `validateResultFact` shape check and exports successfully on its own. Both dependency catalogs use the same complete immutable `json-utf8-v1` ref; their counts are 1 and 2. The combined source projects successfully, exports `kind:'seed'`, and passes `validateSemanticSeed`. Its sole artifact entry contains both dependency-catalog uses with those two counts. Retention is legitimately unavailable and no artifact body is read.

**Contract:** task-1-contracts.md:122 explicitly requires catalog count consistency, distinct from use deduplication, codec validation and immutable ref identity consistency. No new root ruling is needed to reject this contradiction.

**Required correction:** make the shared closed codec reject differing catalog counts attached to one exact ref, including partial-prefix validation when the contradictory uses are already present; the exporter should refuse through that same invariant. Retain legitimate result+catalog dual roles and repeated equal-count use deduplication. Add independently hashed malformed codec and actual source controls, preserving no-body-read behavior and per-envelope validity.

### F7 — [P2] Provision the genuine pinned predecessor for a clean checkout

**Location:** `packages/session-persistence-jsonl/test/format11-predecessor.test.ts:17`–`18` (also fixed evidence output at line 13 and Bun execution at line 68).

The maintained ordinary package test immediately reads the workstation's ignored `.tmp/r4hc-02/gateway-source-copy-map.json` and `.tmp/r4hc-02/g/node_modules` graph. Neither graph nor a deterministic clean-checkout/CI provisioner is committed. The map's candidate entries are resolved as filesystem paths from that workstation. The test also runs `bun` even though the root declares Node/pnpm engines and does not provision Bun for this test. An ordinary clean clone/install cannot execute the maintained qualification test; its first missing-file failure supplies no predecessor behavior evidence. Reusing one fixed output root also does not provide isolated per-run fixtures.

**Evidence and limit:** this is a static portability finding, not a claim that I ran a clean checkout. `.gitignore` ignores `.tmp/`; repository scripts/package setup do not provision this pinned input. Root independently confirmed the same portability gap. The local accepted predecessor qualification is genuine: the report/root identity audit establish copied accepted product `678af03d`, 177 hash-checked old graph files, old `CURRENT_FORMAT_VERSION===10`, ready/header-only/interrupted 11 refusal, unchanged input bytes and zero fetch/repair/upgrade. Those local receipts remain valid evidence of that run and are not being relabeled simulated.

**Required correction:** provide a reproducible explicit supported setup for the exact genuine pinned predecessor graph and its runtime, usable by clean-checkout/CI qualification, with immutable identity/hash checks and imports confined to the copied graph. Avoid workstation-absolute input mappings and use a fresh temporary output root. Preserve strict missing-input failure where qualification is requested. Do not replace the predecessor with a current validator pretending to be old, silently skip the gate, or weaken the literal ready/header-only/interrupted/unchanged-byte assertions.

## Disposition of the five interrupted observations

| Saved observation | Final disposition |
| --- | --- |
| 1. Selected text and source seq might execute accessors | Confirmed separately by A1 (1 read, emitted getter value) and A2 (19 reads); F2/F3. |
| 2. Public backend append might write orphan/extra seed events | Confirmed by B1/B2, successful writes followed by strict read refusal; F4, with root's explicit scoped public-append ruling incorporated. |
| 3. Memory header might change before a failing events assignment | Confirmed by C; F5. |
| 4. One catalog ref might accumulate contradictory counts | Confirmed by D with individually valid envelopes and actual source APIs; F6. |
| 5. Genuine predecessor proof might depend on unprovisioned ignored inputs | Local proof retained; maintained clean-checkout portability defect confirmed statically; F7. |

F1 was additionally found during the resumed full review and confirmed with E. None of these are quota-interruption guesses being promoted without checking their evidence.

## Specification coverage and retained strengths

| B1 area | Review assessment |
| --- | --- |
| None and selected capture | `none` exits before source label/view/payload/hash work; the maintained proxy/hash-counter test is meaningful. Selection uses current effective structural recipes rather than cloning the archive. Consumed 100 MiB raw, envelope-value and inherited-content traps support the R-B-10 tradeoff. F2/F3 prevent closed-source acceptance. |
| Source observations and origins | The preimage excludes the new output origin/digest, retains opaque strings, canonically sorts reachable inherited descriptors, rebases old slot 0 and all relevant metadata addresses, then computes final digest. Independent literal hash and nested slot-order controls are present. Host `current` is checked separately and is not replaced by the observation hash. |
| Turns and omissions | Hidden/empty/open framed turns remain in scalar interval domains; unframed suffix handling and completed first-end mapping match the recorded contract. Selection uses current history, not historical `history(throughSeq)` payloads. Nested T1–T3/local T4 summaries, consumed originals, R-B-11 reverse ordinals and R-B-14 metadata-only omissions have maintained controls. Whole omission straddles refuse rather than clip. |
| Closure and structural history | Shared `closeSourceIntervals` has actual source and reduction callers. Inputs are partitioned before all remaining intervals are closed/omitted. `HistoryFact` stores scalar kind/scope/extent/call/result/media counts, not message/native/text/body arrays; selected rendering reads the record. Group/item/call/result/media local addresses make partial replacement fail incomplete-unit. |
| Provenance, result and artifact observations | Source provenance stays historical; target projection uses inherited observation authority and retains session protection. Legacy results do not gain fabricated envelopes, including observed legacy not-dispatched outcomes. Pruned inline retention does not read or claim the full original value/digest. Artifact role/identity/codec checks exist and visible text is not parsed into grants. F6 is the missing catalog consistency check. |
| Reduction | Seed item messages avoid v1 callId substitution, inherited exchanges are excluded from prune proposals, whole-group summary coverage remains available, and the actual neutral full-request fingerprint/tokens/bytes control demonstrates no-effect markers do not count as progress. The local collision's existing raw substitution behavior is deliberately retained. No provider token-count claim is made. |
| Readiness and ownership | Dedicated non-ignorable format 11 records, header parse/build/view preservation, all-reservation scope keys, public projection/fromJSONL/inbox/state/action refusal and private same-owner growing-prefix staging are present. Complete present partial groups are codec validated. Internal bootstrap is an explicit reviewed source/API boundary, not a sandbox. Existing memoryRecoveryHolds registration implements the R-B-15 bound-empty check without eager validation. F4/F5 remain publication failures. |
| Compatibility | Historical raw remapper/proof assertions and older fixtures were retained; current-writer/future expectations were advanced intentionally. Genuine old format 10 execution-reader refusal evidence exists. F1 breaks ordinary current 10 writable continuation; F7 blocks maintained clean-environment repetition. |
| Scope and evidence honesty | No B2/B3 activation, new store/scheduler/ACL authority, release action or decomposition-only work was introduced. Product remains 0.1.13-rc.1. The real fork baseline remains RED and the staged unused exporter remains visible. Neither is secretly exempted or a surprise B1 finding. |

The interval-order correction has a direct transitive/interleaved helper control and separate supported actual-session open-input coverage. The report correctly does not call it a causal actual-session reproduction of the former ordering; I found no basis to upgrade that claim. The source profile also does not rehash consumed seed payloads or certify whole-source integrity, as explicitly required by R-B-10.

The new capture/codec modules are dense: `captureSeedSelection` spans most of its 178-line module and the closed codec's single routine contains many coupled structural and cross-reference checks. That makes invariant omissions such as F6 easier to miss. This is a maintenance observation, not a demand for the user-deferred decomposition batch. Required corrections should remain cohesive under the existing owners and have direct behavioral regression controls.

## Execution evidence reviewed, source timing and limits

Original evidence root: `.tmp/r4b-b1-20261022/`. I inspected the final log summaries and implementation report; root's static identity receipt records 77 product source files, 84 logs, 11 command-log hashes and 177 old copied graph inputs with zero identity errors. That root audit is not my own product execution.

| Preserved original result | What it supports |
| --- | --- |
| `83-core-head-suite.log`: 477/477, 44 files | Exact product HEAD core suite, after the final narrow legacy-outcome fix. |
| `82-core-type-final.log`: tsc exit 0 per report | Final core typecheck. |
| `77-context-engine-suite-final.log`: 74/74 | Context source before the final narrow core legacy-outcome change. |
| `79-session-persistence-jsonl-suite-final.log`: 148/148 | Local JSONL suite before that same final narrow change; depends on locally provisioned predecessor inputs. |
| `78-session-persistence-suite-final.log`: 177 passed, 1 failed | Sole required existing raw fork archive baseline remains RED; it is not all-suite green. |
| `84-head-reachability.log`: gate exit 1, exactly one NEW row | `@i-harness/core-session#exportConversationSeed` is staged pending its real B2 consumer. It is disclosed, not qualified/exempted. |

Other package typecheck exits are recorded in the original report. Counts above are separate suites, not a sum of overlapping qualification. The preserved initial setup/import failures remain setup failures. Intermediate dirty iterations are not treated as exact final-tree receipts. The disclosed earlier accidental suite overlap is not used as final sequential evidence.

New probe evidence root: `.tmp/r4b-b1-review-probes-20261023/`. The separate sole runtime owner ran:

- `pnpm exec tsx .tmp/r4b-b1-review-probes-20261023/probes.ts` — exit 0, recorded in `01-command.json`; A1/A2/B1/B2/C/D output in `01-probes.log` and `results.json`.
- `pnpm exec tsx .tmp/r4b-b1-review-probes-20261023/probe-e.ts` — exit 0, recorded in `02-command.json`; E output in `02-probe-e.log` and `results-e.json`.

These scripts intentionally record the observed undesired outcomes; script exit 0 means the probes ran without setup failure, not that product contracts pass. I read both scripts and their controls. They use actual source factories/append/export/backend/coordinator/validator paths, local scratch stores and literal ready data. They neither substitute fake product implementations nor access a provider/account or artifact body. The retained `source-comparison.json` reports **131 source files, 0 changed**, exact HEAD `bf4c0aa5`, and clean Git status before/after. Environment receipt: Node v24.15.0, pnpm 12.3.4.

No product suite was run by this reviewer. No clean-checkout runtime, whole-repository verification, connected 100 MiB fork-volume oracle, real dependency transfer/retrieval authorization, native/provider request safety, external-account behavior or later bootstrap resume/launch/reentry qualification is asserted. Those remain later gates. Correcting the seven findings requires source-owned focused regression tests and appropriate affected checks before a fresh review verdict; the current review does not authorize implementation outside B1.

## Scoped F4 public-writer addendum — 2026-10-23

**Verdict and finding count unchanged: REQUEST CHANGES; seven findings, one P1 and six P2.** This is a narrow follow-up to F4 on the same unchanged HEAD `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27`, before any fixes. Root requested two further actual write-path controls. I statically assessed those paths and read the separate runtime owner's probe script, report, command and source/body comparison receipts. I did not repeat the full review, execute product code, run suites or mutate product/tests/index/Git.

### Additional locations and actual failures

`packages/session-persistence-jsonl/src/index.ts:210` validates `replaceEvents` candidate history only when a `compaction/replacement` record is present. At lines 213–214 it encodes/publishes other supplied records with a fresh journal. The valid seed controls contain no such compaction record, so both are published despite violating the exact seed prefix. This method is also used by legitimate owned recovery/canonical rewrites (`session-persistence/src/coordinator/load.ts:130`); the correction must preserve those uses.

`packages/session-persistence-jsonl/src/index.ts:258`–`265` protects journal/format changes, but merges a semantic reservation patch and publishes it after `serializeHeader` checks only its shape. The existing event body is preserved, so an individually well-shaped changed seed digest can conflict with the fixed manifest/group/completion prefix. Normal public reading subsequently detects the conflict, after successful metadata publication.

| Probe | Actual supported setup and mutation | Write outcome / byte change | Subsequent public read |
| --- | --- | --- | --- |
| B3 plain-orphan | Genuine readable plain 11 target; `replaceEvents(id,[literal manifest])` | Resolved; **277 → 1087 bytes** | Rejects `Invalid semantic seed`. |
| B3 ready-no-completion | Genuine readable ready 11 target; replace with its literal records minus completion | Resolved; **2898 → 2633 bytes** | Rejects `SESSION_BOOTSTRAP_INCOMPLETE`. |
| B4 ready-seed-digest | Genuine readable ready 11 target; clone reservation, change one valid hex digit of seedDigest, verify `validateSeedHeader` accepts that shape, then `updateMeta` | Resolved; **2898 → 2898 bytes**, content changed | Rejects `Invalid semantic seed`. |
| B4 title-positive | Separate genuine readable ready 11 target; `updateMeta({title:'changed title'})` | Resolved; **2898 → 2897 bytes** | Read and projection succeed: **3 events / 2 items**, new title. |

All four targets pass actual `backend.read` and projection before the attempted write. Replacement changes no header fields; the digest mutation changes only `semanticSeed.seedDigest`; the title control changes only title. Both metadata controls independently preserve the exact event-body SHA256, including all existing records. Subsequent reads leave written bytes unchanged. Thus this is the same F4 prepublication invariant failure at two further public seams, with a positive control delimiting ordinary mutable metadata behavior.

### Root R-B-16 correction boundary

Root supplied this explicit field/layer ruling on 2026-10-23; it is root authority, not a reviewer-created expansion of the backend contract:

- Public **append and replaceEvents** must use shared strict seed/readiness candidate checks before writing. Preserve legitimate ordinary canonical rewrites and the private owned-batch growing-prefix staging path; do not broaden unrelated legacy cross-event semantics or create a second validator/owner.
- On a **semantic-reserved target**, protect the entire `semanticSeed` value and the fixed birth/lineage fields `seedLength`, `parentSession`, `origin`, `delegationDepth`, `subagentProtocolVersion`, `sessionId` and `createdAt`. Retain the existing `formatVersion` and `journal` fences.
- Public **updateMeta** cannot introduce `semanticSeed` on a plain target, remove/change those reservation or birth fields, or mint bootstrap authority. Equivalent/no-op protected values may be accepted after descriptor-safe comparison. New reservations or changes required for an unprepared target belong to the later qualified bootstrap owner.
- Mutable title/archive/modelSelection/workspace/project metadata continues under existing policy. Do not full-parse or rewrite the body for this metadata fence, and do not reject an otherwise ordinary title update merely because the preserved body has a torn tail.

**Required F4 regression coverage:** keep original B1/B2 append byte-identity refusal controls and add actual backend rejection-before-byte-change for orphan replacement, truncated ready replacement and changed reservation metadata. Cover descriptor-safe protected-field introduction/removal/change and equivalent no-op comparison according to R-B-16. Preserve a supported ordinary canonical replacement, title-only/body-preserving metadata update (including existing torn-tail policy), ready-target ordinary append and private qualified staging. These are corrections to the existing new semantic publication invariant, not authorization for a generic backend redesign or later B2 implementation.

### Addendum receipts

Separate runtime report: `.superpowers/sdd/2026-10-22-context-r4b-semantic-inheritance/task-1-public-writers-probes-20261023.md`. Fresh sibling evidence root: `.tmp/r4b-b1-public-writers-probes-20261023/`; earlier evidence remains preserved. Exact command: `pnpm exec tsx .tmp/r4b-b1-public-writers-probes-20261023/probes.ts`, exit **0**, with **zero setup failures**. See `01-command.json`, `01-probes.log`, `results.json`, the four named before/after JSONL pairs and `source-comparison.json`.

The separate runtime owner checked **131 product/fixture files with 0 changes**, exact HEAD above and clean Git status. Body comparison receipts confirm both B4 metadata bodies are byte-identical before/after. Probe exit 0 records successful execution of these controls, not product-contract acceptance. No fixes, maintained-test changes or suites were performed for this addendum, and no B2/native/whole-B acceptance is claimed.
