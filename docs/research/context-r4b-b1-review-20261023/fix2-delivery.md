# Task1 B1 fix round2 — residual F2/F4

Status: scoped residual F2/F4 corrections committed for the same independent reviewer. F1/F3/F5/F6/F7 stay closed by that reviewer. This report is an implementation/verification receipt, **not self-acceptance** or permission to start Task2/B2.

## Exact source and scope

- BASE: `163e0f469fc658ba9ffb0d962f22dc2115b77169`.
- HEAD: `594f4b259ae62e32b7ec3e3050345deeb2dbeb79`.
- Range: `163e0f469fc658ba9ffb0d962f22dc2115b77169..594f4b259ae62e32b7ec3e3050345deeb2dbeb79`.
- Commit: `fix(core-session): bind selected preparation and metadata snapshots`.
- Tree: `eedebac51c2068e2349fd0c0f27932724f245941`.
- Existing checkout/branch: `D:/I-harness-main`, `codex/v0.1.13-development`.
- **11 scoped source/test files**,219 insertions/27 deletions. Product paths are clean against HEAD; root's three research/plan/progress docs remain dirty and uncommitted.
- Fresh evidence root: `.tmp/r4b-b1-fix2-20261023/`. `final-manifest.json` binds all11 final working-file SHA256s, byte sizes and HEAD Git blobs, all20 log hashes,8 unchanged predecessor fixture/helper/test/tooling identities and the preserved round1/probe report hashes.
- Sole product writer/runtime owner; sequential commands only. No agents, live services/accounts/user sessions, publication/release, dependency install/update, B2 activation, decomposition-only changes or old-evidence writes.

Read the round2 brief first, then the updated full re-review/runtime addendum, preserved actual probes and canonical R-B-18/19. Changes remain under the existing preparation/shape/source/capture and JSONL metadata owners.

## F2: prepared text is captured before selected equality and provenance

The existing input-preparation index retains all reference/action/phase/producer/promotion checks. Its default/full path still invokes the same extracted `validatePreparedInputText` equality check. Only the existing **private semantic-source capability** defers that payload equality; no public bypass flag, second preparation index or persistent store was added.

The input-preparation shape owner now has a private source profile that checks completed observation presence, exact structural fields, producer/count and envelope metadata without traversing its discarded text. Default/full shape validation remains strict.

After structural selection, the shared renderer captures and validates selected raw/admission/derived/referenced-observation text before equality, JSON formatting or provenance. The extracted same-owner checker is reused for both full intake and selected capture. The existing observation wire formatter preserves actual validated field order; text is rebuilt from the owned capture without spreading/re-reading the original payload object.

The selected payload reader caches by **actual object plus property key**, not by sourceRef. Renderer/provenance/preparation checks therefore reuse one owned capture of a given field, while admission text/images (and assistant text/native fields) remain distinct slots even when they share a source address. The provenance text comparison in `conversation/sources.ts` uses this same selected reader. Ordinary raw/no-capture behavior retains its existing path.

Maintained `semantic-seed-prepared-input.test.ts` uses the genuine nondurable admit/capture/start APIs from the original probe, then detaches that exact committed history for descriptor mutation; it does not fabricate preparation linkage. It covers:

- Valid raw+derived source export and admission images/provenance, including distinct text/image payload slots.
- Selected raw, derived, admission and observation benign text getters: **refused with0calls**.
- Plain-data mismatch in each of those four slots: **refused**, with the ordinary full projection equality check also retained.
- Fully consumed prepared component: only its current summary exports while all four historical text/observation getters remain unread. Public/full validation still rejects the malformed historical observation.
- Actual owner admission with a text-first observation object, preserving its exact JSON property order through ordinary full validation and selected export.

Existing consumed100MiB/envelope/seed/native/media, source capture, initial-input readiness, structural getter, memory atomicity and catalog controls are included in the506-test final core suite.

## F4: compare and publish the same owned serialized header

The JSONL metadata owner captures protected expectations as owner-controlled presence flags and canonical strings **before** evaluating ordinary patch properties. Protected descriptor/data preflight still rejects accessors without calling them and retains the established format/journal error wording.

`snapshotMetadataUpdate` evaluates ordinary metadata once, serializes the merged header once, parses those exact bytes into detached owned data, and compares **every** protected final field—including absence/removal—against the fixed expectations. It validates the final owned semantic header. The writer writes the returned checked string directly, with no subsequent patch read, serialization callback or caller alias. Returned metadata is the detached data parsed from those checked bytes.

This remains a header-only update: no event-body parsing, no new metadata owner/policy, and body/torn-tail bytes are preserved. Existing title/archive/model/workspace/no-op edits and public append/replacement checks remain green.

Maintained additions in `semantic-publication.test.ts` establish:

- Exact title-getter mutation reproduction: getter runs once, update refuses **before any byte change**, subsequent stored target remains readable.
- Normal computed title: succeeds with one getter call; protected return data does not alias the patch and remains unchanged when the caller mutates its patch afterward.
- A nested serialization callback changing the reservation before its final serialization cannot publish the changed protected value.
- A whole-header serialization callback dropping the reservation cannot publish the missing protected field.
- Existing protected slot/nested accessors remain0calls, ordinary string/title/torn-body positives and all original birth/readiness negatives remain green.

## Actual commands, source timing and outcomes

Commands below run from `D:/I-harness-main`. Focused Vitest commands use `--maxWorkers=1 --minWorkers=1`; final affected suites use worker2/min1. Every command completed before the next product command.

| Logs | Actual command/scope | Exit/result |
| --- | --- | --- |
| `01-prepared-red.log` | `pnpm --filter @i-harness/core-session exec vitest run test/semantic-seed-prepared-input.test.ts --maxWorkers=1 --minWorkers=1` | **1**,mixed initial result:3 real behavioral failures plus3 descriptor-mutation setup failures on deliberately frozen nested live observations;4 passes. Not accepted as the clean regression receipt. |
| `02-metadata-red.log` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/semantic-publication.test.ts --maxWorkers=1 --minWorkers=1` | **1**,4 failures/23 passes on original round1 product: mutable checked reservation, aliased return and nested/whole serialization callbacks. |
| `03-prepared-red-corrected.log` | Exact core focused command from01, after detaching the genuine committed history | **1**,**4 behavioral failures/6 passes** on original product. Raw getter2calls, derived1call, admission getter accepted, consumed prepared component refused. No setup failures. |
| `04-prepared-green.log` | Core focused run `test/semantic-seed-prepared-input.test.ts test/semantic-seed.test.ts test/semantic-seed-payload.test.ts test/generation-history.test.ts`, worker1 | **0**,40/40 after R-B-18 correction. |
| `05-metadata-green.log` | JSONL focused run `test/semantic-publication.test.ts test/meta.test.ts test/context-format.test.ts`, worker1 | **0**,42/42 after R-B-19 correction. |
| `06-core-session-type.log`, `07-session-persistence-jsonl-type.log` | `pnpm --filter @i-harness/<package> typecheck`, sequential | Both **1**,same compile-time selected reference union needed explicit admission narrowing. Runtime behaviors above were not relabelled as type-qualified. |
| `08-core-session-type-green.log`, `09-session-persistence-jsonl-type-green.log` | Same type commands after explicit admission type guard | Both **0**. |
| `10-observation-order-red.log` | Core prepared-input focused command | **1**,1 failure/10 passes. Self-review added a valid text-first observation owner case and exposed property-order regression in the newly extracted equality reconstruction. This is a real introduced behavior regression, not fixture setup. |
| `11-observation-order-green.log` | Core focused run `test/semantic-seed-prepared-input.test.ts test/generation-history.test.ts test/semantic-seed.test.ts`, worker1 | **0**,37/37 after preserving validated observation key order with owned text. |
| `12-core-suite-final.log`, `13-jsonl-suite-final.log`, `14/15-*-type-final.log` | Initial affected broad/type checks | All **0**:506core,179JSONL and both types. Superseded below after a final capture source-label correction. |
| `16-core-suite-final.log` | `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` | **0**,**506/506**,46 files, final committed core source. |
| `17-jsonl-suite-final.log` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run --exclude test/format11-predecessor.test.ts --exclude test/format10-fixture.test.ts --maxWorkers=2 --minWorkers=1` | **0**,**179/179**,16 affected files, final committed source. The two unchanged predecessor-gate files are explicitly reused below per brief, not silently skipped in maintained tests. |
| `18-core-session-type-final.log`, `19-session-persistence-jsonl-type-final.log` | `pnpm --filter @i-harness/core-session typecheck`, then `pnpm --filter @i-harness/session-persistence-jsonl typecheck` | Both **0** on final source. |
| `20-commit.log` | `git commit -m "fix(core-session): bind selected preparation and metadata snapshots"` | **0**,11-file scoped commit above. |

The final narrow source-label correction distinguishes message payload refs from admission/observation refs; it does not substitute sourceRef for the object/property cache key. Final suites16/17 and types18/19 follow it. No source/test changes follow those checks. Final file/log identities are captured in `final-manifest.json`; intermediate dirty RED/GREEN source states are stated above rather than claimed as immutable HEAD receipts.

## Reused qualifications and remaining gates

As the brief directs, no genuine pinned predecessor regeneration or runtime rerun occurred. The capsule, manifest/licenses, extractor, old/current reader test, strict fixture tests and optional regenerator are **8 unchanged files**, hash-compared against the fix1 manifest. Reused evidence is `.tmp/r4b-b1-fix1-20261023/21-jsonl-suite-final.log` plus `28-predecessor-final-isolated.log`/JSON receipt: the committed genuine old reader and fixture gates passed9/9 in a checkout-like copy with no old evidence/history or Bun. Node/tsx runtime/dependencies are unchanged. No maintained skip/fallback or fixture modification was introduced.

No public facade/type/package export changed in this round, and no unrelated package failure occurred, so context/persistence suites and reachability were not rerun. Fix1's sole required real raw-fork baseline RED and sole disclosed staged `exportConversationSeed` reachability row remain recorded; neither is exempted, fabricated away or claimed green here. No whole-repository verify:all, Task2/B2/native/dependency/connected-volume acceptance is asserted.

## Files and preservation

Core: `src/conversation/{input-preparation,payload,render-items,sources,validation}.ts`, `src/events/{conversation,input-preparation}.ts`, and new `test/semantic-seed-prepared-input.test.ts`. JSONL: `src/{format,index}.ts` and `test/semantic-publication.test.ts`.

The earlier implementation report SHA256 remains `bbbf97fff67c2298e11a5c2351766cf0e79bdac63110b6ceae217792ebac1c69`; the unchanged follow-up probe report remains `4e9d25f9dab813e105873fc64b205effdb46e97b1e5f8ff3f4ae549ecdfa1b57`. Original, fix1 and probe roots remain untouched. Root's documentation changes are not staged or committed.

Self-review checked private profile boundaries, selected ownership/capture order, exact observation formatting, payload cache identity, default full checks, protected expectations/final serialized bytes, detached return values and no post-check callback. No further concrete contract gap is known in this scoped correction. Independent specification/quality acceptance remains with root and the same reviewer. Product version remains0.1.13-rc.1; runtime is finished and idle.
