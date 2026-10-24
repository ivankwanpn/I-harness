# F0 fix round 1 — connected owner review

Spec review: **Needs Fixes**. Quality review: **Needs Fixes**.

Reviewed incremental `ab314b81e70a75c884fa4edf572db567f638357e..187eea5545f5ab462e210e168e2db6cb9af1deb9` and its interactions with the previously reviewed full connected range `ca81bdd2ec944105b9fd62534a932336e587179e..187eea5545f5ab462e210e168e2db6cb9af1deb9`. Frozen NATIVE checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`, branch `codex/fork-binding-observation-20261024`.

The original review is preserved. This round read the correction report, latest on-disk progress ledger, the root's additional F0-R1-04 capture ruling in the dispatch, all three changed files/diffs, the original bootstrap/capture/preparation owners, and relevant raw correction evidence and manifests. This is a source-level read-only review: no runtime, tests, builds, Git mutations, product edits or subagents. The only write is this report. The protected retirement directories were untouched.

## Remaining finding

### [P2] Capture failure retries caller inspection through an unfenced bootstrap path

Locations: `packages/session-persistence/src/coordinator/binding-observation.ts:64–66` and `69–72`, specifically the catch fallbacks at lines 65 and 71. Connected original owner: `packages/session-persistence/src/coordinator/bootstrap.ts:235–247`.

Both wrappers assume that anything which failed the new capture will also be refused by the original owner. They therefore call `run` directly on the original caller objects when capture throws, without `bootstrapMutation`, pending admission or observation revocation. This assumption is false for stateful guard inspection. Neither the new capture nor the original owner excludes a Proxy `BootstrapGuards` object, and both independently inspect its `targetPreparation` property descriptor.

A concrete source-level reproducer uses the existing valid JSONL existing-empty ancestor request while an external observation callback is paused on that ancestor. Wrap otherwise valid guards in a transparent Proxy whose `getOwnPropertyDescriptor` trap throws only on the first `targetPreparation` inspection:

```ts
let inspections = 0
const guards = new Proxy(originalGuards, {
  getOwnPropertyDescriptor(target, key) {
    if (key === 'targetPreparation' && inspections++ === 0) {
      throw new Error('first inspection failed')
    }
    return Reflect.getOwnPropertyDescriptor(target, key)
  },
})
const bootstrapping = coordinator.bootstrapSemanticTarget(original, guards)
```

The full request capture succeeds. New `captureBootstrapGuards` throws at line 55. The line 65 fallback directly calls the original managed/bootstrap owner. Its second inspection succeeds, so it can run the valid original request using the already pinned same-coordinator session ownership, rewrite the observed ancestor's header/lineage and complete bootstrap. No new mutation admission occurred, so the ancestor observation remains current over stale metadata. The same bypass exists for `resumeSemanticTarget` at line 71; it also skips explicit retirement/deleted admission checks in `bootstrapMutation`. This needs no backend/file bypass, different lock root, or native failure. A one-shot failing target-preparation `has` trap can produce the same control flow.

The original owner would have returned its normal `manifest-invalid` refusal on that first failed inspection before this wrapper was introduced. Retrying caller-controlled inspection after an exception is therefore also a refusal-semantics regression, not an intentional compatibility requirement. The existing malformed/accessor request test remains valuable but cannot prove that all capture failures are permanently malformed.

Required correction: ensure a failed pre-admission capture is terminal and cannot invoke a potentially successful bootstrap/resume outside admission. Preserve the original refusal classification without re-inspecting mutable caller capabilities on an unfenced success path. A shared original-owner capture/refusal result or another deterministic refusal path is acceptable; do not simply catch and forward the raw caller objects. Add bootstrap and resume controls using a one-shot guard inspection failure against an actually observed existing-empty ancestor. They must prove no header rewrite/issuance and no self-wait, while retaining ordinary malformed/accessor refusal, original-target shared-flight recovery and live guard receiver behavior.

This finding is based on static control flow and original-owner validation. No new reproduction was executed in this read-only review.

## Disposition of the original findings

**Original I1 is addressed on the successfully captured path.** Bootstrap/resume now synchronously register pending session mutation admission, revoke all intersecting non-exempt scopes, and join before calling the original owner. Bootstrap-first work prevents a later observation from joining a held lane. The exception is derived from the inherited callback scopes and canonical equality with their captured target invocation, with no caller-supplied bypass. Explicit retirement markers stay separate from ordinary bootstrap pending admission, allowing exact original target flight sharing/recovery while refusing later retirement adopters. Actual existing-empty ancestor controls cover active observation, bootstrap-first admission and original unknown-header resume. The remaining finding is the capture-error escape around this machinery.

**Original I2 is addressed.** Request/ID-array proxies are rejected before descriptor/prototype inspection. The supplied array requires the ordinary Array prototype and a bounded own length; numeric enumerable own data descriptors are copied directly. Caller iteration is no longer consulted. Captured IDs are rechecked for bound, safety, distinctness and target exclusion. Subclass, altered prototype, Proxy and numeric-accessor controls assert zero caller execution and zero native acquisitions.

**Original I3 is addressed.** Signal brand/currentness use a captured intrinsic AbortSignal getter, and listener operations use captured EventTarget methods with the genuine signal receiver. Instance getters/method overrides are not consulted. Listener installation now occurs after cleanup assignment inside the settled lifetime; listener removal is included in disposal error aggregation while all document locks and session pins remain attempted. Early installation failure can therefore reach lifetime settlement, and failed removal remains explicit cleanup debt. The actual add/remove/accessor override and pre-abort/active-abort controls are appropriately scoped; they do not claim to force a native EventTarget implementation failure or an OS-wide handle census.

## Capture-before-await and compatibility review

For successful captures, F0-R1-04 is implemented correctly: complete bootstrap request, invocation, optional resume payload and target-preparation presence/absence/method references are captured synchronously before the new admission join. The captured values, not original mutable caller payloads, reach the original owner after the wait. The two disjoint-observation tests retain a genuine nonempty semantic seed and show that mutation toward a second identity cannot redirect the successful captured path.

The target-preparation port is captured using its existing owner utility. Other guards forward to the original receiver: Stop/signal, source `assertCurrent` and dependency access remain live as before. The original bootstrap owner then performs its existing validation, shared-flight comparison, header publication, fact issuance and recovery; there is no second bootstrap flight registry or readiness authority. `openManagedDocument` now returns a rejected Promise for admission refusal, matching its declared async API. The existing 58 physical bootstrap controls are unchanged and pass in the recorded final source range.

Unchanged owner logic remains as assessed in the original connected review: actual identity claims and acquisition/release flights; native release debt with same-capability retry; short metadata lanes and callback outside lanes/docChain; synchronous metadata/document/deletion revocation; manifest document OS exclusion; strict JSONL absence classification; dependency-ordered close with dependent original owners retained after unresolved observation/managed work. This correction does not alter those files. It introduces no payload replay authority, fabricated revision, arbitrary key selector or native backend rewrite.

## Evidence inspected

The correction's command receipts record package CWD, executable/argv, times, exit status and worker flags. The final raw logs record **244 persistence passes plus the unchanged original F1 RED**, **264 JSONL passes**, and **zero exits for both package typechecks**. Final persistence includes 49 passing observation controls. This is not a fully green persistence package claim.

The corrected original-source RED records 12 behavioral failures, one already-passing accessor case and 32 skipped old tests. Earlier fixture timeouts remain retained separately. The initial full JSONL correction run records five failures/259 passes: deferred preparation capture and synchronous loader refusal regressions. The unchanged physical bootstrap controls subsequently pass 58/58 after the interface correction, and the final full JSONL gate passes 264/264.

The R1-04 source-cut experiment is honestly labeled counterfactual, not an original-HEAD failure. Its stderr shows actual `ready` receipts for `other-ancestor` / `mutated-operation` when the admission fence retains uncaptured forwarding; restored source passes both unchanged controls. The separate earlier fixture error omitted `cold.meta`, and its failed receipt is preserved. No F1 oracle weakening or reseed appears in this correction.

I independently hashed all eleven current physical owner files and compared them with `committed-source/manifest.json`; all physical SHA256 values match. The manifest explicitly distinguishes CRLF physical bytes from canonical LF Git blobs. The four final-gate comparison lists no physical mismatches. The original-preservation receipt records all 295 original entries unchanged, original report/manifest hashes unchanged, and no added old-subtree files. Root's independent audit remains the authority for a complete evidence-subtree audit; this review does not claim independent execution or a dependency/runtime environment snapshot.

## Acceptance boundary

The three original findings have normal-path corrections and causal controls. The unfenced capture-error fallback remains a concrete owner gap, so this frozen range should not receive owner approval yet. Correct it, retain the existing receipts, add its causal controls and fresh source-bound verification, and return the updated connected range for review.

F0 remains staged owner work. F1's actual `acquireCliForkTransfer` production consumer, stdio request, nonempty catalog/member transfer, ordinary cold target reopen, original-invocation adoption and final vertical-range reachability are later obligations. They are not demanded inside this correction packet, and its semantic source control still has an empty external dependency closure.
