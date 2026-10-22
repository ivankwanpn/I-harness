# Task 1 — B1 semantic source/reader contract report

Status: implemented and committed for root's independent review. This is **internal B1 contract staging**, not shipping semantic fork/spawn inheritance, B2 bootstrap acceptance, or whole-B acceptance. The real raw-fork causal baseline remains RED exactly as required.

## Source and ownership

- BASE: `0fb20ee93124cfb40f71205feaf0f4a5bd747257`.
- HEAD: `886045296831cb1aea438f4d1a0999dd27efe5d3`.
- Review range: `0fb20ee93124cfb40f71205feaf0f4a5bd747257..886045296831cb1aea438f4d1a0999dd27efe5d3`.
- Commit: `feat(core-session): stage semantic seed reader and format11 contract`.
- Tree: `a58b78b6850214511d3e278780669a321e11c446`.
- Reused `D:/I-harness-main`, branch `codex/v0.1.13-development`; initial checkout matched BASE and was clean.
- One product writer and runtime owner; no agents spawned. No live provider/account/session, push, merge, tag, release, or decomposition-only work. Product version remains unchanged. No Task 2 work began.
- Root's independently edited design-decisions and implementation-plan documents remain **unstaged and uncommitted**. Only scoped package product/tests are in the commit (77 files, 2379 insertions, 134 deletions).
- Evidence: `.tmp/r4b-b1-20261022/`; accepted `.tmp/r4hc-02` was only read for hash-checked predecessor copying, never executed or written.

## Implemented behavior

The source exporter accepts only session/anonymous labels. None exits before label/view reads, projection, normalization, or hash calls. Non-none export validates the source through the same structural validation/history owner with root-approved R-B-10's private source profile, resolves original turn boundaries, uses current effective/monotone history, closes source intervals, and captures only selected recipes. It never clones/stringifies the view or imports executor/provider authority.

The shared payload-free `closeSourceIntervals` has real reduction and inheritance consumers. Source selection partitions safe input observations before closure, then closes **all** remaining descriptors before deciding which whole intervals to omit. It keeps input-only evidence and explicit links to excluded open/unresolved work. Completed/N selections refuse straddling summaries/groups/omissions; hidden summaries do not restore consumed content. Inherited hidden turn counts stay scalar intervals rather than expanding every ordinal (the regression control observed 30,045 Set insertions before the fix).

Codec1 validates closed own data, unions, origins/indices, turn intervals, input/omission reverse links, call/result pairing and order, native carrier schemas, media companions, result retention observations and exact artifact roles. Selected capture is a single descriptor walk into owned data; subsequent validation/hash passes read that capture. A regression caught three source walks and changed to one. Opaque wire strings retain byte/property order; the exact envelope-string test caught and fixed capture key-order reversal. Pruned inline results retain preview/media and size evidence without reading the original inline value or manufacturing its digest. Legacy results remain legacy, including source-recorded not-dispatched observations; no envelope or dispatch execution claim is synthesized.

Origins normalize reachable historical descriptors by canonical UTF8 bytes, rebase every relevant slot (including old slot zero), drop unreachable descriptors, retain new source-local refs at slot zero, rehash omissions, then hash the root-selected noncircular source preimage. Current origin and final seed digest are filled afterward. Source observation hashes remain content observations, never freshness or read authority. A real memory-bootstrap current guard rejects changed host state even with identical exported observations.

Dedicated format11 manifest/group/completion records are in the core event union and non-ignorable registry. History facts retain only structural seed descriptors/recipes, not messages/native/result bodies. Rendering reads selected seed records directly. Each item has its own local item source and shared group source; partial replacement coverage fails incomplete-unit, full replacement works, and later hiding its summary leaves originals consumed. Imported exchanges project inherited-observation, original provenance remains nested observation, session-scope input stays protected, and no inherited pending/delegation/effect authority is created.

Public projection/indexes/fromJSONL/append/managed-state/generation/inbox/action paths enforce readiness. Header-only/partial reservations refuse. The scope/cache key includes every reservation scalar; mutable-header changes cannot reuse the old scope. The internal `./internal/bootstrap` bridge reuses the same managed/index owners for growing-prefix staging and atomic standalone installation. Every staged complete group is validated before installation, including before the final marker. Memory bootstrap rejects fresh-target aliases that already have nondurable owners using a read-only query over the existing `memoryRecoveryHolds` map (no new registry). Public factories have no skip-ready option.

Format11 journal branches are explicit. Header parse/buildSession/managed view preserve the reservation. Old formats still read with their old semantics and acquire no ready certificate on upgrade. Current-writer/future-version assertions and current-format test backends moved to11/12; literal historical fixtures and raw remapper proof expectations were preserved. The dedicated reduction consumer skips v1 prune proposals for inherited exchanges; seed rendering never uses the global v1 callId substitution map. A full neutral-request fingerprint/token/byte control confirms a seed-only marker has no semantic reduction, and actual reduction uses whole-group summary fallback with a local/inherited callId collision. Raw local v1 substitution semantics remain unchanged.

## Root rulings applied

These rulings were requested with concrete source/codec evidence and supplied by root; they are not implementer-created authority:

- **R-B-09:** shared manifest event `seq:number`, exact runtime0, preserving existing addressed-event/remapper TypeScript construction.
- **R-B-10:** package-private selected-source structural validation in the existing index/history owner; no full hidden-payload integrity/receipt claim. Full public/intake/target validation remains strict.
- **R-B-11:** relatedInputs is the sorted unique reverse relation of zero-based **input-only** ordinals across emitted items; rebuild both sides after selection.
- **R-B-12:** shared fixed none seed/dependency digests, independently derived in tests, no none-export hash.
- **R-B-13:** initialInputDigest hashes the complete validated actual admitted event excluding only seq, plus original startedAt/expiresAt, under `ih.bootstrap.initial-input.v1`; public readers recompute it.
- **R-B-14:** required omission extent, included in omission hash; all/N/completed nested selection retains/excludes/refuses whole omission extents, including unlinked metadata-only observations. This conservatively refuses a narrow selection crossing an audit interval.
- **R-B-15:** descriptor/scalar validation before boundary reads; pristine-memory binding is detected from the existing nondurable owner's registration map, not a new registry or early index priming.

## Causal RED, contract RED and fixes

All named logs below are under the evidence root. No setup/import failure is described as the original defect.

| Logs | Command/scope | Observed outcome |
| --- | --- | --- |
| `01-fork-red.log` | `pnpm --filter @i-harness/session-persistence exec vitest run test/semantic-fork-baseline.test.ts --maxWorkers=2 --minWorkers=1` | Real existing fork/coordinator/JSONL archive; visible contents match literal summary/tail, then actual archive assertion fails because CONSUMED-PROOF-ONLY remains. Product source was exact BASE; bounded4096 body. |
| `02-contract-red.log` | core semantic-seed + semantic-seed-turns | 5 new-contract failures on absent exports; **not** causal-old-defect evidence. |
| `03-source-first.log` | same source contracts | 5 passed. |
| `05-reader-red.log`, `06-reader-red.log` | core seed replacement | Fixture/import setup failures; corrected before behavior qualification. |
| `07-reader-first.log` | core source/turn/replacement | 10 passed. |
| `10-reduction-red.log` | context dedicated reduction | Wrong test import path; setup failure, corrected. |
| `11`, `12` | context dedicated reduction | Initial test controls passed because short text/zero tail did not produce a useful prune; strengthened before accepting a regression. |
| `13-reduction-red.log` → `15-reduction-green.log` | context dedicated reduction | Actual inherited prune proposal produced before guard; 2 passed after guard. |
| `16-payload-traps.log` | core source traps | Selected inherited content getter executed; fixed capture preflight. |
| `17-source-profile-red.log` → `18-source-profile-green.log` | core source traps, original full source profile temporarily selected then restored | Two consumed-envelope/seed controls refuse under original full profile; restored private structural source profile passes12. |
| `19-origins-first.log` | nested origin + turn controls | 3 passed. |
| `20-pruned-scope-red.log` → `21-pruned-scope-green.log` | pruned inline and scope readers | Pruned envelope originally refused/read discarded original; fixed actual projection handling. Cold malformed fixture encoding setup also corrected. 15 passed. |
| `22-omission-red.log` → `23-omission-green.log` | input-only reverse links | Real wrong/empty reverse links; 12 passed after rebuilding and validation. |
| `24-predecessor-first.log` → `25-predecessor-green.log` | actual frozen10 reader | First attempt was invalid fixture header missing sessionId, **not a reader defect**; corrected fixture then 2 passed. |
| `27-interval-red.log` → `28-interval-green.log` | source interval contract-order correction | New private helper missing, then transitive/interleaved closure control and real open-input composition passed14. This is **not** a causal actual-Session reproduction of the former filter order; no invalid Session was invented to manufacture one. |
| `29-one-capture-red.log` → `30-one-capture-green.log` | selected result source walks | Expected1, observed3; single owned capture fixes it. |
| `32-core-suite.log` → `33-core-regressions.log` | existing raw/core suites | Found unavailable-history reads in incremental raw indexes and obsolete writer/future expectations. Corrected fixed-prefix validation and format expectations; affected original suites202 passed. |
| `34-none-initial-red.log` → `35-none-initial-green.log` | zero seed and full initial binding | Changed admission accepted before R-B-12/13 checks; 8 passed afterward. |
| `36-codec-red.log` → `37-codec-green.log` | independently hashed closed codec negatives | Unknown native carrier/malformed thinking and order/media gaps detected then fixed. |
| `38-payload-red.log` → `39-payload-green.log` | exact envelope string/order | Capture reversed source object key order in wire string; preserving source insertion order fixes it. |
| `40-turn-interval-red.log` → `41-turn-interval-green.log` | scalar inherited turn range | 30,045 insertions for10k hidden ordinals before fix; scalar interval arithmetic passes. |
| `42-inbox-version-red.log` | inbox readiness + unsupported-source format | Both missing checks reproduced; fixes covered by44 and later full suites. |
| `43-omission-extents-red.log` → `44-omission-extents-green.log` | R-B-14 whole omission ranges | New required codec contract initially refused; all/N/completed metadata-only nested cases pass26 after extent selection/rebase. |
| `53`, `54` → `55-reduction-integrated-green.log` | full neutral-request reduction | Test measurement API misuse, then test expectation corrected to retain existing raw local v1 substitution; actual inherited no-effect + whole-group fallback pass3. No provider token-count claim. |
| `58`, `59` → `60`, `61`, `62`, `63` | persistence/JSONL regression suites | Obsolete current10/future11 expectations and current-format mock fixtures fixed; raw proof/byte-preservation assertions retained. |
| `64-self-review-red.log` → `65`, `66` | scalar getter + already-bound memory target | Both actual boundary gaps reproduced;35 focused tests pass after R-B-15 fixes. |
| `67-growing-prefix-red.log` → `68-growing-prefix-green.log` | actual internal managed staging | Unknown permission item field was accepted in a partial prefix; present-group codec validation rejects before installation. |
| `69-managed-cold-green.log` → `70-managed-cold-green.log` | actual current JSONL managed reader | First managed test used disabled ownership lock, correctly refused; enabled actual exclusive owner and passes ready append + incomplete-before-repair. |
| `80-legacy-outcome-red.log` → `81-legacy-outcome-green.log` | actual legacy source outcome | Existing projector records not-dispatched for a stepless aborted legacy result; exporter originally refused. Preserve that observed scalar without parsing text/inventing envelope;6 focused tests pass. |

Typecheck iteration failures are preserved in04/08/09/26/45–48; corrections include the root-selected seq typing, narrowing annotations, and test fixture typing. They are compile/setup findings, not causal prompt bugs.

## Final verification

Commands use package-local `pnpm exec vitest`, maxWorkers2/minWorkers1, and were run sequentially for the final source. No whole-repository verify:all/provider qualification was run.

| Command | Evidence | Result |
| --- | --- | --- |
| `pnpm --filter @i-harness/core-session typecheck` | `72-core-session-type-final.log`, latest `82-core-type-final.log` | exit0 |
| `pnpm --filter @i-harness/context-engine typecheck` | `73-context-engine-type-final.log` | exit0 |
| `pnpm --filter @i-harness/session-persistence typecheck` | `74-session-persistence-type-final.log` | exit0 |
| `pnpm --filter @i-harness/session-persistence-jsonl typecheck` | `75-session-persistence-jsonl-type-final.log` | exit0 |
| `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` | committed HEAD `83-core-head-suite.log` | **477/477**,44 files, exit0 |
| same command, context-engine filter | `77-context-engine-suite-final.log` | **74/74**,8 files, exit0 |
| same command, session-persistence filter | `78-session-persistence-suite-final.log` | **177 passed /1 failed**,29 files, exit1; sole failure is the explicitly required raw fork archive baseline |
| same command, session-persistence-jsonl filter | `79-session-persistence-jsonl-suite-final.log` | **148/148**,16 files, exit0 |
| `node scripts/audit/check-reachability.mjs --gate` | committed HEAD `84-head-reachability.log` | exit1; exactly **one new** unused-export row: `@i-harness/core-session#exportConversationSeed` |
| `git diff --cached --check` before commit | commit operation | exit0 |

The full package runs76–79 precede the final narrow legacy-not-dispatched codec fix. After that change, focused payload/codec6 passed (81), core typecheck passed (82), and **the entire core suite passed on committed HEAD (83)**. The change adds no exported type/API change and does not alter other package code. No claim is made that the unrelated package suites were rerun after that final narrow codec change.

The reachability row is an intentionally staged API awaiting its real B2 caller. No fake consumer, baseline rewrite or exemption was added. The audit also reports pre-existing unmatched allowlist/progress rows; those were not changed.

## Predecessor qualification

The accepted predecessor is product `678af03dd54659e22dd5f941112c06ec9917e812` (delivery `282f6ecf18d39747fdcff507e35f53b31c206d3a`). The new evidence root contains only a COPY of the needed old graph:10 packages,177 regular files, all177 verified against the accepted gateway copy-map and then against copied bytes. Receipts: `predecessor/copy-receipt.json`, `predecessor/test-copy-receipt.json`, `predecessor/reader-receipt.json`. All runtime package resolutions in the old runner must stay under that copy and it asserts CURRENT_FORMAT_VERSION===10.

Actual old coordinator.load refuses ready11, header-only11 and interrupted11 as newer than its build. Every file remains byte-identical; instrumented fetch/repair/upgrade counts are0. The runner imports only the copied persistence/core graph and provides no auth/model/dispatch owner; no provider/credential/account is resolved or invoked. This is offline reader-fence qualification, not live-provider/native execution qualification. The maintained qualification test requires this pinned sealed input graph; a clean environment must provision it, and absence is a qualification error rather than a simulated predecessor or silent skip.

Current11 also parses/builds/opens the literal ready seed, admits an ordinary local record under an actual held owner, and refuses header-only/interrupted targets before repair. Actual literal10 is read/upgraded without inventing semanticSeed.

## Self-review and limits

- Reviewed source capture, scalar/body separation, history descriptors, nested turn/origin/omission algebra, closed codec, public readiness/cache scope, internal composition, no inherited prune/effect authority, and actual old/current readers. Author review is not independent acceptance; root owns the fresh review.
- The interval-order correction has a direct transitive/interleaved structural control and a separate valid real-Session open-input control. Current history normally shares physical-unit state across siblings; no supported actual Session causally reproducing the former filtering-order issue was found or invented. Report this as contract-order correction, not a demonstrated prior sent-request defect.
- R-B-10 deliberately does not validate/hash discarded source payloads. Public full validators still reject malformed hidden envelopes/seed payloads; selected malformed equivalents refuse without executing getters. Historical digests do not mint a fresh receipt or whole-source certificate.
- R-B-14 can conservatively refuse narrow exports when an omitted audit interval crosses their boundary. It does not clip omission ranges or revive discarded work.
- One exploratory process handling mistake: the first persistence suite58 exceeded the10s command yield, and JSONL59 began before that process finished (about3s overlap). Both logs are preserved and are **not the final sequential evidence**. Final76–79 explicitly waited for each process to complete; no simultaneous product suites remain running.
- Intermediate dirty worktrees were not snapshotted into immutable trees for every iteration. Historic logs retain actual output/command scopes and task BASE identity; the causal baseline ran before product edits, and final committed source/tree and final receipts are exact. Do not interpret intermediate logs as receipts for the final HEAD.
- No independent review, Task2/B2 acceptance, full connected100MiB fork-volume oracle, dependency transfer/ACL receipt, native/provider request qualification or external-account behavior is claimed.

Later work still owns compileSemanticSeed, durable bootstrap coordinator/resume/dependency issuance, actual fork/spawn/team/import consumers, artifact retrieval integration, initial task launch/reentry, and inherited-native compatibility/credential constraints. The B1 internal bootstrap bridge and exporter must acquire those genuine consumers at the connected gate. The real fork baseline and one reachability row remain visible until then.
