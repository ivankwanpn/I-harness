# Task 1 independent spec and quality review

**Verdict: PASS for the owned-version qualification unit. No actionable findings.** Root remains the integration and acceptance owner; this verdict does not accept whole R4A or a release.

Reviewed the full fixed range `538cdb9297bbf6c4f757dfd69d3a48239032e4b8..1755ee0745de134fc7bd60ba1dc2e3b3dd92170b` on `codex/v0.1.13-development`: 13 test files and the delivery document, 300 insertions and 47 deletions. The implementation test commit is `cdb55a4ba4aa704956ab1a0296c1bbdb71b1e2c3`. The root-approved VERSION-01 amendment in the current working-tree plan is part of this review's requirements. The separate native-producer plan is excluded.

## Strengths

- The predecessor controls exercise real JSONL and coordinator owners, distinguish literal source versions 8/9 from the decoder's current in-memory version, preserve the complete input header except its version, preserve the exact framed body, commit exactly one managed metadata record, close fully, and construct fresh disk-backed owners before reopening. See `packages/session-persistence-jsonl/test/retained-format-ownership.test.ts:45`, `:57`, `:68`, `:77`, and `:81`. The unchanged original literal8 fixture also retains its direct coverage in `format8-predecessor.test.ts`.
- The unresolved reservation and legacy unknown result have substantive oracles: no disposition appears, the whole generation-action derivation remains equal, the historical result remains exactly `TOOL_OUTCOME_UNKNOWN` with `replay:false` and no envelope, no new dispatch/child facts appear, no child authority marker is added, and fetch remains unused. Event-prefix equality also preserves the historical context result reference. See `retained-format-ownership.test.ts:75` and `:85`.
- Each of the five retained-result slots has a valid current10 structural fixture and a separate actual owned append/close/fresh-reopen success control. Exact event equality preserves the supplied execution, artifact reference/revision, completeness, media, dependencies, child revision and job revision rather than only checking previews. See `retained-format-ownership.test.ts:102`, `:115`, and `:125`.
- The 15 refusal controls alter only the header to literal8, literal9 or future11. They assert a changed fixture with identical body, the specific original validation error, no ownership remaining, byte-exact source preservation before and after close, and zero calls through delegating spies for repair, upgrade, replacement, append, journal read/truncation, managed append and reconciliation. The real backend has those methods; no fake decoder or ownership implementation supplies the expected result. See `retained-format-ownership.test.ts:23`, `:26`, and `:151`.
- The version corrections follow the original oracle purposes. Genuine predecessor data, future99, literal6 Unicode/CRLF body checks, pending-batch assertions, and generation total-cap9 remain. The replacement discriminator now actually changes the current10 header before asserting refusal. Callback-order corrections retain lazy/getter order, post-await method lookup, receiver and sequence-canonicalization assertions. The Windows ownership fixture correction retains its second-coordinator acquisition proof. These are consistent with VERSION-01.
- The delivery distinguishes characterization from product RED, preserves non-qualifying setup/process evidence, and explicitly limits the copied-owner claim. The fixed diff contains no production, API, dependency or version changes.

## Issues

### Critical

None found.

### Important

None found.

### Minor

None requiring action. Optional formatting preferences are not defects in this unit.

## Evidence inspected

- Read the review brief, implementer brief/report, complete current owned-version plan including VERSION-01, and complete delivery document.
- Read the entire saved 50,072-byte fixed diff in bounded chunks; confirmed its 14-file scope with the read-only range stat.
- Examined the original literal8 fixture and the relevant original JSONL `read`, `repair`, `upgradeSessionFormat`, framed migration and journal mutation paths; coordinator owned load/preflight/writable-format paths; core JSONL serialization and result-validation boundaries; and the complete callback-order test. In particular, core `fromJSONL` retains header metadata, and `toJSONL` changes structural journal framing before the fixture is stored. The predecessor test's byte-preservation oracle is against that stored predecessor input; it does not claim that structural fixture generation preserves an older writer's raw frame bytes. Original literal8 raw-byte coverage remains separately present.
- Inspected saved receipt20 and receipt21 JSON, final stdout summaries and stderr. They record sequential package-root runs with `--maxWorkers=1 --no-file-parallelism`, exit0, respectively 146 tests/15 files and 153 tests/26 files. Receipt20 retains the injected file-close diagnostic from its successful cleanup test; receipt21 stderr is empty.
- Inspected saved receipt27 JSON, stdout and stderr: the copied qualification file records 24 tests, exit0, with an absolute config path and package-scoped root. Inspected receipts22/23 and24: both type gates and the Gateway build record exit0. All these receipts record identical before/after source digest `c66dc6831267156a2f9dda9974f4d35e0bc1622b5491ca532443aeb4b62dcc43`.
- Root completed its separate provenance audit during review and supplied `root-verification.json` in this workspace. Its recorded summary has no failures: 2,616 source files, 33 stable receipts, the documented excluded12/13 overlap, 172 sealed artifacts, 78 mapped packages, 1,141 source-identical copies, 322 internal edges, one generated file, two fixture files and three transformed imports. I read this result as root-owned provenance evidence, without claiming to have repeated its hash and resolution audit.

## Recommendations and limits

Accept this unit. Root's independent copied-source, fixture-transformation and evidence-inventory audit is now recorded without failures. No implementation fix or additional runtime discriminator is requested by this review.

This was a read-only source/evidence review, except for this report. I did not execute tests or builds, mutate Git, modify product/test files, inspect another SDD workspace, access live user data, or dispatch agents. The passing counts above describe inspected saved run outputs, not fresh reviewer executions. I did not independently recompute every source/copy hash, internal dependency edge or inventory hash; root explicitly owns that parallel verification. I did not re-audit every preserved setup/baseline receipt, and do not reclassify them as product RED.

These controls qualify offline library/backend/coordinator version behavior and the described isolated copied-owner route. They do not prove live provider/native producer execution, installed profile behavior, packaged IPC, installer/CLI release, 100MiB fan-in, all R4A obligations, or release readiness. The fixtures deliberately relabeled8/9 with retained current facts test refusal; they are not evidence that historical writers emitted those facts. Zero fetch plus unchanged event facts supports the scoped no-execution assertion; it is not a general provider integration test.

## Assessment

**Spec compliance: PASS. Code quality: PASS. Ready for root acceptance of this unit: Yes.** The approved requirements are represented by discriminating positive and negative oracles through the actual owners, and the saved final evidence is consistent with the scoped delivery. No actionable defect was found in the reviewed range.
