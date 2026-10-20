# Original reviewer — external A3 delivery

Reviewed incremental range `4730ca83f5f3e97a1ab5a4bf8d8d2b5131987456..0cf2d24f`, including product commit `954f6c878426a6b55fb65899b31c11f023f60d4e`. This review covers the new A3 delivery, not the previously accepted scoped exec refinement. The diff contains eight product files, eight test files and one delivery document. Root is authorized by the user to review and directly adjust the product; this reviewer remains independent and read-only.

**A3 specification verdict: changes requested. A3 quality verdict: changes requested. Whole R4A ready to merge: No.** Removing the legacy temp-spill fallback and using the managed artifact codec are useful parts of the cutover, but the required original output-fact representation/order has not been implemented, and the new artifact lifetime is not safe for original passive settlement after Stop. These are necessary A3 responsibilities, not merely deferred A4/A6 work.

No product/test/Git changes, suites, commits or agents were run by this reviewer. Only this new report was written. Previous reports/probes/evidence remain unchanged. Root owns runtime controls and evidence verification; the source findings and suggested discriminators below do not claim independently executed runtime results.

## Findings

### A3-F1. [P1] Cut over the original output fact instead of archiving the full raw text before retaining a second copy

**Unimplemented necessary A3 integration, with new duplicated managed storage.** At `packages/code-mode/src/register.ts:74`, every admitted item is still persisted through `facts.required({ type: 'code/output', content: event.item })`. `runtime/output.ts:73-78` calls this from the admission barrier before installing the item. Only the later observation projection at `runtime/output.ts:112-135` joins all admitted text and calls the new retention port.

Trigger: a real managed cell emits one accepted text item larger than 64,000 bytes, within the existing 4MiB default admission limit. The original F1 archive already receives the complete raw item before the artifact is even opened. Successful retention then writes another complete text representation to the artifact. Known artifact quota refusal still leaves the entire raw text in F1. The full raw event remains readable in the session archive, and `core-session/src/projection/search.ts:20-25` derives the full text from it; Gateway later clips its display, which does not bound or remove the archived bytes.

The ordinary model-facing observation can still be bounded. This finding does **not** infer a direct raw-body model leak from the archived event. The demonstrated source problem is full raw archive retention outside the new artifact policy, duplicate complete storage, and artifact capture occurring after the original raw F1 publication.

The delivery report's §5 argument that retaining full `code/output.content` is required to preserve the original receipt/authority is inconsistent with Task A3's explicit requirements: capture accepted items under the original source, confirm retention before publishing its ref representation, cut over the event/projection/consumers together if needed, and do not preserve a new ref alongside the old complete raw text. Changing a fact's closed data representation while preserving its original owned source/capture/receipt does not create a second semantic authority. The current code instead changes only a later observation window and leaves the original shipping archive path in place.

Correction boundary: perform the retained representation work inside the original output admission/required settlement boundary and preserve item identity/order and media semantics. Persist a bounded closed representation using that original F1 authority; update its actual codec/projection/reader consumers coherently. Preserve explicit known unavailable versus unknown dispositions. Do not replace the raw body with an arbitrary slice, fabricate a tool call, add another completion journal, or keep both complete representations as the final solution.

Discriminating root control: use the real managed mount and a literal ~70KiB accepted text; hold `beginResult` after it is entered and inspect committed `code/output` facts before releasing storage. Assert no complete raw body was already archived and each archive/model representation satisfies its applicable bound. Repeat with known quota refusal and verify the complete body does not escape into raw F1. Existing raw-item count assertions prove once-only event count, not the required representation/order or storage policy.

### A3-F2. [P1] Keep an issued original artifact operation recoverable after observer/Stop cancellation

**New lifecycle defect.** `packages/session-executor/src/lifecycle/code-text-retention.ts:35-36` registers the original artifact scope with `current: () => active && !input.origin.abortSignal?.aborted`. The supplied signal is assembled at `runtime/output.ts:124` from the cell's retention-stop signal and the original/observing caller signals. Runtime cancellation aborts retention-stop for every retained cell, including a completed guest with a pending projection.

Trigger: the first artifact finish is unknown before physical commitment (the same kind of cut used by the new unknown-finish test), then Stop/caller cancellation occurs. `opened` is true, so retry enters the same capture. The actual artifact writer subsequently checks its original lifetime before write/commit and sees the permanently aborted signal; it returns recovery-required instead of finishing the original accepted capture. Removing the injected storage fault cannot restore that signal. The original pending projection consequently cannot complete passive settlement, even though the guest has already ended and no new execution is required.

This can occur in the actual managed Agent path without an additional human Stop: core-agent `tool-batch/dispatch.ts` recognizes the genuine retained-outcome recovery failure and calls `stopForCheckpoint`, whose existing batch cancellation aborts `batchAbort`. `registerCodeMode` passed that batch signal as the cell origin's abort signal. The new artifact lifetime therefore observes the checkpoint cancellation generated by its own recovery-required result. The standalone unknown test supplies no such original agent signal and does not exercise this feedback path.

A related state distinction occurs at lines 37-38/48: `opened` becomes true only after `beginResult` resolves. If initialization was physically issued but its result is unknown/rejected, `opened === false` does not prove no operation exists. An abort then returns the known `capture-canceled` disposition at line 48 without resolving that issued initialization. This is the same original-operation lifetime/uncertainty boundary and should be corrected together.

The original contracts explicitly preserve required passive settlement and original holds through Stop; Stop removes future execution/publication permission, rather than proving an issued artifact operation absent. Known cancellation before an operation is issued can remain a known refusal. An already-issued operation needs its original bounded reconciliation path and ownership until its disposition is known, while confirmed deletion/source retirement retains its separate fence.

Correction boundary: distinguish pre-issue admission cancellation from original issued storage lifetime, retain the authentic capture/operation and required source through uncertainty, and allow only passive reconciliation of that same operation after Stop. Do not clear an abort signal, grant new execution, replay guest/output callbacks, create another capture or infer success from stage files.

Discriminating root controls: prefer an actual managed Agent/registry unknown-finish case so the original batch checkpoint signal is present; release the fault and require the same scope/sink/operation to resolve. Also extend the real artifact runtime fixture with Stop/cancel before `drainRetainedObservations` and assert no second guest/capture/write sequence. Separately inject an unknown initialization result after the real store created the operation, cancel, and require reconciliation rather than a premature known cancellation. The present Stop control holds the wrapper **before** invoking the real factory; it only exercises the pre-issue case.

## Why current passing controls do not close these findings

- The new `retained-code-output` managed fixture asserts three raw `code/output` events and a later artifact. It verifies item order/content preservation and artifact codec bytes, but it explicitly accepts the duplicate raw archive behavior in A3-F1. Its tools registry has no managed ordinary result-retention port, so the returned observation bound is not itself proof of the complete production F1/model cutover.
- Its unknown-finish test uses an actual runtime/store with a no-op `retentionRecovery` callback and no Stop. It proves a same-operation retry while the lifetime signal remains live. It does not exercise the actual managed tool/source hold and cancellation fence.
- `managed-context-output.test.ts` formerly injected an unknown reference receipt, called Stop during recovery and reconciled. The migrated test removes the injection and calls Stop only **after** successful `agent.run`. That is useful committed-artifact readability evidence, but it is not an equivalent uncertainty-through-Stop replacement.
- `native-context-output.test.ts`'s new Stop test delays calling `createCodeTextRetention` until after cancellation, so `opened` is false and no artifact operation has been issued. Its capture-canceled result does not qualify issued writes/finish/initialization cuts.
- The changed lifecycle test exercises five protocol framings with the bounded observation and manually retained ref values. It does not establish new `code/output` archive/projection shapes, because those shipping paths were deliberately left unchanged.
- The report acknowledges no 1MiB/100MiB emitted-code qualification, packaged real-entry flows or actual restricted child mount coverage. These are limitations; the two findings above do not depend on claiming those deferred broad gates as new defects.

## Other source observations

The new factory uses the existing streaming `createResultCapture` and `json-utf8-v1` codec, which preserves quoted strings, backslashes, NUL, emoji and lone-surrogate JS values in the retained body. It coalesces concurrent settlement and clears only recovery-required cache entries, retaining known unavailable dispositions. The explicit no-owner path removes the old temp-file fallback. Those changes are aligned with part of A3.

The current artifact is joined text for an observation window, rather than an ordered complete admitted-item representation. Existing raw F1 item events currently preserve the surrounding media order. Fixing the raw archive cutover therefore must preserve the item/media relationship through the actual original output representation instead of merely deleting those facts and relying on a text-only join.

Nested `textRetention.envelope` refs are ordinary tool-result data under the current managed-ref enumeration, which recognizes only top-level result slots/catalog refs. Broader different-owner/catalog membership is already unaccepted scope; this review does not add an unprobed separate cross-owner finding from that inherited boundary.

## Inspected range and callers

Read the full A3 delivery report, Task A3/global constraints in the completion handoff, and relevant original ENC/DEP/COLD/HOOK/PIN/program/media requirements. Inspected all eight changed product files:

- `packages/code-mode/src/{index,register,runtime,types}.ts`
- `packages/code-mode/src/runtime/output.ts`
- `packages/session-executor/src/{assembly,context-output}.ts`
- `packages/session-executor/src/lifecycle/code-text-retention.ts`

Inspected all eight changed test files and their actual fixture/fault behavior. Related callers/owners inspected include Code Mode event-facts, cell state/admission/retirement/runtime observation recovery, core-tools retained outcomes and genuine result registration, core-agent retained batch settlement, ContextOutput scope/writer/owner confirmation and bounded read tools, core-session raw output event/search and conversation rendering, Gateway code-output display, and the normal/child assembly retainText composition sites.

No acceptance of report baseline comparisons or sealed evidence is inferred solely from the delivery prose. Root independently verifies source-time results, the claimed preexisting failures and maintained manifests. This review's actionable findings are source-traced; runtime status will be appended only when root supplies new discriminating results.
