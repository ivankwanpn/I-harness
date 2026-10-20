# Independent spec and quality review — child completion qualification

Reviewer: fresh independent delegated GPT6.1Sol reviewer. Review scope: BASE `fd6177c213b7a8872979f1a3d9d5bd4c2d88a4ac` through HEAD `5de6299c1e57dbdd1cd782b8865a836876897f17`, including tests commit `3c468c70519e1a6b14939102d2ce8defb600664c`. Applied the requesting-code-review skill's code-reviewer template. Reviewed the complete fixed `review-fd6177c2..5de6299c.diff`, approved plan, task brief, immutable implementer report, progress, and tracked delivery. Then inspected original lifecycle/result/registry/retention owners and the affected fixture context to verify concrete observation, identity, publication and cleanup concerns.

## Strengths

- `packages/subagent/test/tools.test.ts:277` replaces the arbitrary microtask readiness assumption with a deferred resolved by the real subscribed running publication for the actual entry. The original clearing, numeric start time, fresh controller, complete new text and exact two-publication assertions remain. The additional held-guest checks exclude an early waiting patch. Cleanup releases the guest and awaits the actual drive.
- `packages/subagent/test/tools.test.ts:1098` retains the foreground completed summary and full result assertion before separately capturing and joining the child's initial completion. In this fixture no followup is enqueued, so the one captured handle is the original initial lifecycle, rather than a chain extended by future work. The resident/job assertions occur after that join, with exact terminal publication counts and actual child turn/step/assistant evidence.
- `packages/subagent/test/tools.test.ts:1245` separately checks TaskRecord outcome, text and source/call identity after the original 10,000ms task wait. It joins its already captured original initial completion before making the nonblocking job-output observation, then checks exact complete text, terminal count and single child execution. Both affected spawn tests retain their original 15,000ms bounds.
- `packages/subagent/test/followup-settlement.test.ts:27` obtains the previous result through the real `captureChildResult` and publishes its pending projection through the real child result owner. The wrapper modifies the original handle's `settle` method and delegates to its bound original method after release; it does not replace `entry.resultCapture`, its owner or its current predicate. Actual `TaskResultOwner` and `createResultCapture` code own the pending-to-retained transition.
- `packages/subagent/test/followup-settlement.test.ts:55` checks the held barrier before clearing output, changing controller/start time, publishing running, consuming inbox work, invoking the guest or creating a second capture. After release it observes actual retained inline settlement before guest entry, and verifies one followup, a distinct real next revision, current-predicate transfer, complete text and exact publication sequences. The rejected variant asserts the exact injected error through the returned drive while preserving the original capture and evidence. Cleanup releases/rejects gates and awaits the real drive or its explicit rejection assertion; it introduces no swallowed failure.

## Spec compliance

**PASS.** All three named observation corrections and both prior-settlement discriminator variants are present. The changes retain the original oracle content and add owner-specific checks. No production owner or public export appears in the reviewed diff, and no fake job completion, timer extension, repeated future-chain lookup, generic status stub, arbitrary microtask count or early F1 bypass is introduced.

The original owners support the distinctions encoded here. `followup/drive.ts` awaits the previous capture before its running patch and guest dispatch; `child/lifecycle.ts` assigns the initial completion through `onSettled`, result publication and initial-generation close; `tools/spawn.ts` and `tools/spawn-source.ts` own the TaskRecord/foreground summary separately; `task/registry.ts` waits for TaskRecord outcome; `tools/status.ts` keeps job output nonblocking without `wait:true`. The table-add subscriptions in the spawn tests are installed after real job registration and before deferred initial guest transport, so they observe the real terminal publication. The inline result test's initial completed job is published by the actual child result owner with its original pending descriptor, rather than manually forced to satisfy either spawn test.

## Quality issues

### Critical (must fix)

None found.

### Important (should fix)

None found.

### Minor (nice to have)

None found within this bounded qualification scope.

## Evidence and limits

The reviewed delivery and immutable implementer report record 103/103 passing tests across nine files and passing subagent `tsc --noEmit`, with five sequential final commands at the same complete 2,559-file before/after manifest. They explicitly classify the historical three failures as stale-oracle evidence, the first passing settlement controls as characterization, and the two earlier public-stream spy failures as author instrumentation errors. No product RED or production fix is claimed.

This is independent static spec/quality review. Per the assigned split, I did not rerun tests/builds or duplicate root's source, receipt, manifest and seal audit. Runtime counts and stable-source evidence above are reported implementer evidence pending that independent root audit, not newly executed reviewer results. No product edit, Git mutation, live profile/provider use, other SDD workspace read or agent dispatch was performed. The only reviewer write is this file.

The new controls qualify original inline capture settlement and followup serialization. They provide no durable artifact storage, reader authorization, cold recovery, installed-host, automatic-wake, release or whole-R4A proof; the tracked delivery correctly states these limits. No runtime discriminator or production design ruling is needed for an unresolved concern from this review.

## Recommendations

Accept this tests-only qualification after root's already assigned evidence/source/seal audit. Continue the approved explicit-result-pages work under its own scope and evidence requirements. No corrective implementation request is outstanding from this review.

## Assessment

**Spec verdict: PASS. Quality verdict: PASS. Ready for root acceptance: Yes, subject to root's independent evidence/source/seal audit.**

The tests now observe the event or original completion promise that owns each assertion, while retaining content, identity, publication-count, controller and time-bound checks. The added original-capture controls meaningfully protect the prior-settlement barrier without expanding their claim into durable storage qualification.
