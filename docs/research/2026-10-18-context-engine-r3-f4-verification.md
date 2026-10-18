# ContextEngine R3 F4 verification

2026-10-18. **Status: F4 accepted through e82a26b0 after original-reviewer fix1 approval.** This is a connected execution-ownership gate, not completion of the ContextEngine redesign or a release. Product version remains0.1.13-rc.1.

Full task BASE: 4b4cbe47ce0adb963c4f05948105477128794372.
Initial delivery: c6a78be1bdbb04ed6194895a7284a8a507cb1f0a.
Fix1 candidate: e82a26b07abbe59e30454c2998d218b78791cfa5.
The [task plan](../superpowers/plans/2026-10-18-context-engine-r3-f4-physical-attempts.md) supplies the contract; the [master progress record](../refactoring/context-engine-progress.md) tracks remaining phases.

## Delivered behavior

The existing F1 document/journal owns generation actions, physical reservations, honest local invocations and once-only input preparation. Format8 validates the closed facts and references across live/staged/cold paths. There is no new spend sidecar or authority reconstructed from copied scalar IDs.

A physical request requires a durable reservation and a final live owner/candidate/Stop/deadline check at the actual HTTP or installed SDK handoff. System proxy/dispatcher resolution and SDK credential/signing waits precede that check. Managed redirects refuse; SDK retry is disabled at its owned client. Arbitrary callbacks, injected transport, copied prepared handles and generic wrappers do not gain managed execution merely by exposing matching fields.

For a main response and its associated summary/recovery, r retries gives main/recovery lanes of r+1, summary physical limit8 and total2*(r+1)+8. Manual summary has its own8 bound; title/approval use their selected retry bound; direct media uses1. A main response's60minute default and stricter caller limits do not refresh after retries or reopen. Accepted tool work retains its actual lifetime; a settled accepted predecessor can authorize the next response. These bounds apply to actions, not the entire length of a conversation.

Known-unsent rebind requires original live proof, keeps the same ordinal, invalidates the old ticket and is limited to3total per action. Unknown handoff spends conservatively. Required original settlements can drain after Stop without granting another send.

Actual caller integration covers main/CLI/Desktop/service, fresh/resident children, summary/manual, both guardian modes, title, ordinary/CodeMode tools and direct audio. Raw human input remains once; derived host context has separate lower-authority framing. Literal/system/delegated input acquires no implicit command transformation. Early CLI execution preserves recovered FIFO and explicit model-policy precedence.

Operational bookkeeping does not advance semantic context or retire an input-compatible B2 sample. Token arithmetic and global pressure/target policy remain R2E work. The narrow new-format detached semantic import limitation remains explicitly assigned to R4B.

## Implementation and review sequence

| Commit | Scope |
| --- | --- |
| 9f5d93e4 | Format8 closed ownership/input lineage, F1 support and readers. |
| ef81295d | Owned HTTP/SDK terminals, bounded local execution and transport composition. |
| c6a78be1 | Real caller/lifetime integration and controls. |
| e82a26b0 | Original-scope service completion and cleanup fix1. |

The fresh full-range GPT6.1Sol review found two Important service defects: uncertain post-title drain left the caller pending/running, and Stop during held extension refresh skipped ingress cleanup. Actual zero-network service/F1 probes reproduced both. They were sent together to the original implementer.

Fix1 introduces one completion owner and a narrow post-submit owner. Every acquired-scope exit attempts original ingress cleanup before caller settlement. Ordinary host callback failure retains its fail-soft behavior; required title/source cleanup failure is reported without losing quarantine or masking the original error. A deferred member call preserves the callback's live read after binding and its original receiver.

Actual regressions establish finite caller rejection while title reconciliation stays unknown; bounded recovery of the same original frame; no replay of accepted main/tool effects; exactly-once stopped close/cancellation/finish under known and uncertain cancellation; and usable later explicit input. Four focused controls pass after the final callback refinement. The original reviewer read the full454-line fix diff and covering evidence, closed both Important findings, and found no new Critical/Important breakage. Spec and quality fix-round verdicts are approved. Minor F4-M1 and all later qualification obligations remain open.

Original full review report SHA256:00a78218a9e1fbbca2ad4b27f9be5d61fe14f8d3b5fa3b262354664bc563c07d. Scoped re-review report SHA256:e9b01d465cb543728f41ee6e1e7a51e7946acb87f4fabba441c289728d14b496. Root acceptance is limited to this F4 gate; no whole-branch or release approval is inferred.

## Scoped verification

Counts below overlap; they are not an additive whole-project total. Receipts are bound to the source timing recorded in the task reports.

| Scope | Evidence |
| --- | --- |
| Core session / persistence / JSONL / query |397/397;152/152;115/115;51/51. Some core/persistence receipts precede later caller refinements; they are not relabeled final-HEAD runs. |
| Seam / mock / HTTP |149/149;8/8;14/14. |
| Chat / Responses / Messages / Gemini / Bedrock |158/158;217/217;170/170;182/182;113/113. |
| Provider / runtime / compaction / tools |Provider174pass/2initial-cause BASE failures; runtime91/91;compaction191/191;tools133/133. |
| Initial complete executor / SDK / CLI |410/410;93/93;351pass/1existing skip. |
| Child / Team / guardian / title / media |Child293pass/4BASE concerns;Team121/121;guardian100/100;title15/15;media15/15. |
| CodeMode / Gateway / core Agent |90pass/2BASE concerns;456pass/52BASE concerns;360pass/39BASE concerns plus1unhandled outcome. See the qualifications below. |
| Initial types/audit |25package scopes plus CLI pass; reachability selftests82/82 and gate passes without new rows or allowlist/baseline changes. |
| Initial copied runtime |66/66 plus actual shipping Gateway/bundled CLI main, reduction, retry, Stop and observation flows. |
| Fix1 complete executor |413/413 BEFORE the deferred callback refinement. |
| Fix1 after final refinement |Focused service/title49/49 and final4/4 regressions. These overlap. |
| Fix1 host/CLI |Gateway6/6 and CLI22/22 source checks; final copied Gateway10/10 and actual bundled SDK service flows use the committed fix. |
| Fix1 types/audit |Executor/Gateway/CLI types and reachability gate pass. |

The literal controlled20-send and9-send recovery traces preserve an earlier tool effect exactly once. Actual process-cut tests cover reservation/handoff/acceptance/settled-tool boundaries. Source and copied controls cover final awaited guards, own child lineage, late CodeMode work, audio and input preparation.

The initial actual bundled capacity control waited10072ms between two main calls, with2reservations and1accepted response. The initial SIGINT control stopped after one handoff and recorded no next send; it is not before-issue zero-send proof. Fix1's actual bundled SDK control recorded3handoffs/3reservations/2accepted exchanges/3turnends, idle queue after normal and canceled callers, and a usable later input.

Early failed, incomplete, setup-error and type-error receipts remain. An IPC-channel-closed CLI run is recorded as incomplete, followed by separate completed single-worker runs. No timeout was increased to turn a failed test green.

## Independent source and artifact verification

Root independently checked committed Git blobs, raw source hashes, EOL-normalized equivalence where appropriate, exact artifact bytes, copy mappings and production targets. It did not rerun existing test suites to recreate their evidence.

| Closure | Independently verified |
| --- | --- |
| Initial source/artifacts |2534source inputs;9310artifact files;1063copy pairs;12transformed-test mappings;71production import targets;0errors. |
| Initial evidence |475sealed files plus report;0mismatches. |
| Fix1 source/artifacts |2537source inputs;9312artifact files;1065copy pairs;6transformed-test mappings;20production import targets;0errors. |
| Fix1 evidence |44sealed files plus report;0mismatches. Active review ledger excluded. All original475 files unchanged. |
| Exact BASE integrity |3108Git source blobs and453dependency targets/package metadata checked after comparisons;0errors. This does not claim every installed vendor asset was separately hashed. |

Initial source/artifact manifest SHA256:
a0d8570783d314ea3cbc6b9b4a905cf19301b59948e6e48c100d816fa66cb64b.

Initial evidence seal SHA256:
f0ae91e99524e57ab8fe5cb6f9bc581a3a3075b0acb5077327f34a5991a32cac.

Fix1 source/artifact manifest SHA256:
eea6801a5a04f674af59ce957817eb0c2736be812583f6e36b290ede93979581.

Fix1 evidence seal SHA256:
98de113ca490f0e706749bd653e28cb9ff027bfc8f1823b45cfd16c695d281c0.

The task workspace is .superpowers/sdd/2026-10-18-context-engine-r3-f4-physical-attempts/. Initial progress/brief/report files are immutable delivery evidence. Active review/fix bookkeeping is review-progress.md; separate review/fix reports preserve the original seal. Task reports contain precise artifact paths and receipt identities.

## Remaining qualification and framework work

**Renderer remains FAILED/unqualified.** The current initial failure is node:util/types in core-session/managed/capture.ts; exact BASE first fails on node:crypto/createHash in events/usage-anchor.ts. These are distinct causes, and unchanged leaf files do not prove unchanged dependency reachability. The [R5 observation plan](2026-10-16-context-engine-r5-preflight.md) records the required browser-safe boundary repair. No permissive stub, polyfill or strict-validation weakening is accepted as a workaround; shipping renderer qualification is required before release.

The CLI build retains36dynamic TypeScript import warnings. Actual exercised bundled paths pass, but unexecuted branches are not qualified. An exact BASE full-build comparison was blocked by the deliberately absent BASE.pnpm store; no recursive junction/install workaround or false build-failure equivalence was used.

Historical core/subagent/provider/CodeMode/Gateway comparisons match displayed initial causes, not nested behavior or coverage of paths blocked earlier. F1-CLOSE-OBS-01, earlier C3/history/fork/calibration observations and old broader failures are not retired by these scoped tests. Warnings are not described as pristine output.

The review's Minor F4-M1 identifies repeated full-generation-history replay and reference-map scans on guard/settlement paths. This is an unmeasured static scalability concern, assigned to R6's existing owner-backed derived-index and large/cold-history work. It is not fixed by finite request counts and must remain on the complete-framework acceptance list.

New helper functions stay small; fix1 reduces the service composition920→872 and submit180→132 nonblank lines. Original decomposition acceptance remains27/43. R2E shared policy, R4A/B/C, R5 and R6 remain unfinished; broader event-driven/instruction/unrelated decomposition remains paused. F4 alone is neither a finished redesign nor a release.
