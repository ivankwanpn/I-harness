# Retained live batch continuation design

This is a bounded repair within the approved integrated v0.1.13 program. The user authorized continuing implementation and GPT-6.1 Sol delegation. Product remains0.1.13-rc.1, Session format12; no release or pure decomposition is part of this task.

## Problem and outcome

The current tool registry can retain a genuine completed observation while throwing its original recovery error. executeToolCalls records that observation and drains the original work, but finishCheckpointFailure always rethrows and the Agent ends the turn. Closing the generic delegated batch source also cannot release a hold owned by its still-live invocation source. A recoverable result therefore need not produce a usable continuation.

After the original batch has fully settled and released its own managed settlement source, an exact live-turn handler may continue through the ordinary next-step path. It must keep the same invocation, accepted input, request context, original observations, tool execution metadata and error evidence. Historical Code Mode attempt003's first trigger is still unknown: the controlled repair proves the selected mechanism, not that missing historical cause.

## Binding decisions

- LC01: Use a real batch source issued by the actual invocation action. Track its exact identity in the existing sourceDrains set until original close succeeds. Generic invocation delegates remain unchanged. Do not live-close the invocation source or live-drain the whole fact owner, which can wait on the operation itself.
- LC02: Preserve checkpoint occurrence separately from its value and keep the current error precedence. Only core-tools' private retainedToolOutcome(error,prepared) evidence is eligible. Raw/undefined flushes, later raw failures, outer/commit/post-tool/telemetry/policy/cleanup failures, aborts and any started unknown effects disqualify the entire batch.
- LC03: All batch slots must exist and be recorded, all original takes/references/finalization must settle, and committed must equal batch length. Never-started known canceled slots remain recorded and are not dispatched again. Successful drain alone is insufficient.
- LC04: executeToolCalls still throws the SAME original error. Only its successful original source close can produce a private one-use eligibility mark bound to that exact error, batch, invocation and live turn. The catch belongs outside handoffBatch; cleanup wrappers must not be unwrapped or requalified. No public callbacks/flags or cause matching can mint eligibility.
- LC05: Reserve eligibility once, validate the original invocation/Stop/borrowed allowance, await the existing exact-view owned readiness port, then repeat guards. Missing readiness, unrelated holds, wrong view or failed cleanup refuse continuation. Guard failure retains the original error plus the actual guard failure through existing savingFailure behavior.
- LC06: Borrowed reviewer guards retain their actual original generation check at mint, validate the consumed binding/view/action and do not borrow again or renew. The accepted normal main generation is already legitimately closed before tools and must not be asserted or reopened.
- LC07: Continue only in the same running loop. No new run/followup/input, repeat preparation/capture/producer, new recovery model action, extra store or authority. The ordinary successor model generation remains normal behavior. Canceled executable lifetimes stay canceled; unrelated background jobs are not globally awaited or canceled.
- LC08: Keep public unmanaged executeToolCalls behavior and the AGENT_BUSY invocation lease. No event/schema/protocol/native/backend/llm-seam grant change. Internal helpers remain package-private and organized by responsibility.

## Acceptance

One connected implementation/review range must demonstrate a real JSONL-backed Agent/CodeMode unknown-after-landed output publication, reconciliation using the same original handle, child and parent final answers, one accepted input/producer/output, failed outer tool metadata preserved, and the actual recovered result in the next child request. Preserve the initial RED and original journal evidence. If the mechanism needs a deterministic gate, hold only that same original handle until the observer fails; do not synthesize receipts or rerun until green.

The plan's negative matrix covers actual private identities, failure occurrence/precedence, incomplete effects, original cleanup and IC-B pin errors, live readiness, Stop, borrowed allowance expiry/revoke, known detached work and concurrent operation refusal. Review the complete range independently. This task does not accept all R4B/C2/native/event/platform/release obligations.
