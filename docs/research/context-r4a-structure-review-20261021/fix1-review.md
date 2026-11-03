# Fresh reviewer fix1 recheck

**Disposition: bounded PASS; the original P2 workspace-read regression is CLOSED. No additional actionable P1/P2/P3 finding was identified in this repair.** This recheck supplements and preserves the original `review.md`; it does not retroactively accept its rejected candidate or erase the original failing evidence.

Reviewed incremental range `f9b0dcd79e628e8776a717937a7df126481b1f51..ae56ce0996e4cc5f9738c798d200b89ee5032f0e`, full structural range `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994..ae56ce0996e4cc5f9738c798d200b89ee5032f0e`, with product/test repair freeze `f7086d8acbf6febb5724688408d597beabae1d03`. Read the complete fix delivery, local report/handback/seal audit, actual incremental product/test diff, regression source, replay/equivalence helpers, raw native reports/observations and source/evidence inventories. Only this new review file is written. No product/test/Git mutation, new agent, product runtime, old runner or sealed-evidence execution was used for this recheck.

## Why the P2 is closed

Service now supplies `() => options.workspaceId` without evaluating that property at capture admission. The capture leaf invokes the getter separately in `referenceId(...)` and the following `workspaceId` field expression, exactly where the original body read the property. It introduces no cached scalar or extra await. The closure evaluates the same `options.workspaceId` member access, preserving accessor receiver, timing and count. Existing lazy `getStore`, config reads, producer invocation, mutation lane, validation/disabled behavior, options mutability and service lifetime remain unchanged. The incremental product diff contains only this getter signature/call and the two original reference expressions; no new identity policy, state owner, clone, freeze, lock, queue or authorization was added.

The new actual public-entry test distinguishes the repaired boundary from both the rejected early scalar and a single cached late read. Constructor calibration uses a separate fresh service/root, verifies its three preexisting accessor reads and proves no legacy directory was opened. Each target case starts another fresh unopened service, holds the real producer and records zero capture workspace reads before release. After release it expects exactly one lazy-store read before directory creation and two reference-construction reads after the store opens. The same mutable options object is changed only in the mutation case. Independent literal SHA/reference identity, workspace directory, persisted ref, live body and fresh cold body oracles remain; finally releases/joins the capture and closes the services.

I inspected the actual native failures and observations, rather than only the delivery summary. Unfixed gate01 has constructor1pass and capture2fail: an early pre-release accessor read appears; the mutation case produces the wrong workspace/ref and records `Invalid context artifact identity` on cold reopen. Byte-exact original BASE-entry gate02 passes the same3 tests. Repaired gate03 and affected gate04 also pass the same3. The test's SHA256 is identical across all four gate input manifests: `582114d6d1e6312b4c0d2eaaa6348106b5c536d8c5fa7ff4d0beeaf8d83c37fe`. BASE/fixed observations agree on the original zero-before-release and three-after-release trace, producer1, exact live/cold literal body and activeJobs0. The checks were not weakened after RED.

Replay's BASE buffer hash matches the old sealed original service buffer, and its restored pre-repair buffer matches the earlier frozen candidate. Gate02's source manifest records that original entry; gates03/04 record the repaired service/capture bytes. Scope remains honestly BASE service-entry replay with unused new leaves and current shared package closure, not a full BASE checkout. The existing independent reviewer public control remains preserved separately; a second runtime reproduction was unnecessary given the discriminating unchanged tests, original control and complete new native traces.

## Verification and evidence checked

Independent read-only hashing confirmed all53 portable encoded originals decode to their recorded byte lengths/SHA256 and match their raw sealed sources. All748 regular evidence files/14,253,339bytes hash-match;12 links are recorded without traversal. Fresh filesystem enumeration exactly matches the760-entry inventory plus its two declared exclusions. All2676 final source/input entries match current bytes. All2671 product/test/root-config inputs are identical to the final affected run; its four then-current helper inputs also match. Only the declared evidence finalizer was added afterward.

All10 gate receipts are sequential/nonoverlapping and source-stable. I checked the actual native reports: gate01 exit1/1pass/2fail; gate02 exit0/3pass; gate03 exit0/3pass; gate04 exit0/**87pass in11 exact current files**. Gates05–08 are four successful affected type scopes, including executor's explicit mixed-retention `.mts` configuration. Gates09/10 pass updated token-equivalence and frozen census. Source inspection confirms the getter is evaluated at its original expressions; token equality is supplementary. The updated proof explicitly acknowledges that body tokens alone do not prove argument timing and that the earlier scalar substitution was insufficient.

The affected run covers84 prior affected tests plus3 new tests. The prior210-test source-scoped evidence supplies126 unaffected tests; no fresh213-test combined run is claimed. Task/S25 and their existing result/outbox/persistence/observation owners are unchanged in the incremental diff, so the original bounded positive review conclusions and unchanged-source evidence remain applicable. No full connected suite or types was independently rerun during this read-only recheck.

Independent TypeScript AST inspection reproduces47 scoped files with no function≥250lines or≥18000characters. Service remains176lines/9365characters, capture35lines/2116characters and registry201lines/8866characters. The previously reviewed catalog121, artifact ownership172 and job registry145 cohesion exceptions are unchanged. Delivery explicitly supersedes the old scalar capture-port notation with the new getter notation; the responsibility/lifetime boundaries otherwise remain as reviewed.

All12 recorded public timing observations finish with jobs0. All five final mixed fixture cleanup records join native/broker/coordinator closure, open=false and zero Context/Code jobs. Preserved fixture bytes are intentional evidence after joined owners close. The process/cleanup assertions retain their stated task-root scope; they are not a universal OS-handle audit.

I also rehashed the original writer inventory's1432 regular files and24 link identities, and the independent review control's80 files and8 links. Both remain unchanged, with their original seal hashes `6965b347e3eb85580c49097c3dc51c414553236f87f5b65aa6a1a7b14fc24705` and `027f582f3881152e861cefb27cffc15e7d3a94c799efe36292debb988b06d8d2` respectively. Original failed receipts/review bytes were not rewritten.

Verified fix1 identities:

| Artifact | SHA256 |
| --- | --- |
| Final source/input inventory | `43e2bc1a8480f5d13c54361382f6aaa7acd62ef6663fdb2aca9de8a52b74b798` |
| Evidence inventory | `60ec10a1d28013d9f151c84203ae01a5cab1eea64bcd220a76f99dde9d5fbf9e` |
| Outer seal | `a1a638494fd7568ecb674f1fa8a15b3d8dfc7eea831806cd1428bc107353027c` |
| Frozen fix1 handback | `38c51296a9c73ca2948dc3312dfa05734add68dee0598f50e8f209537659108c` |

## Remaining boundaries

Normal reachability was neither rerun nor repaired by this increment. Its previously demonstrated exit1,399 rows and six unchanged public-export findings remain open; there is no new full-green normal graph claim. No API removal, exemption, reseed or fake consumer was introduced. Root-owned legitimate public-surface retirement remains separate.

The original P2 is closed for this exact repaired range, and this reviewer finds no remaining actionable blocker to the bounded structural unit. Root audit and acceptance remain distinct. This report does not mark original S25/CX2 credit/counter27/43, R4C receiver claims/admission/wake/branch epochs, whole R4A/A6, scale100MiB/100child, copied/bundled/renderer/provider/installer or release qualification complete.
