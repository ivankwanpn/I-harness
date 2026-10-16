# R1 semantic conversation and snapshot contracts

Approved architecture: [ContextEngine](2026-10-15-context-engine-redesign.md) and [framework](2026-10-15-context-engine-framework.md). User authorized implementation2026-10-15. This document fixes the data-layer interfaces before product edits. Phase execution continues without another approval prompt.

## Delivery sequence

1. **R1A**: one semantic conversation projector with source/provenance and exchange metadata; old message APIs become facades, valid wire behavior preserved.
2. **R1B**: format3 semantics fence, explicit accepted response facts and trusted input provenance; flush acceptance before effects; seed/reference and legacy format migration.
3. **R1C**: immutable ContextSnapshot and real core-agent request/freshness consumer; separate archive/semantic/protection/branch/context/binding identities.
4. **R1D**: structural complete-exchange selection and positional replacement record/rendering, consumed by compaction entry points only together with the necessary R3 durable-publication foundation. Full R3 reduction/attempt policy can follow; no interim append-position summary or live-before-durable replacement producer is enabled for non-prefix selections. R2 may precede this integrated delivery where the final prepared-admission contract is required.

Each delivery receives its own concrete task plan, tests and independent review. S20/CX full decomposition credit requires their complete separate gates; touching an admission or backend helper here is not completion credit.

Ruling: Pull positional replacement DTO/rendering into R1D — protecting current human inputs while reducing closed steps in the same turn requires non-prefix selection, and the old prefix-summary replay would include protected inputs or misplace the result — if wrong, limit migration to a known safe contiguous eligible span and keep blocked diagnostics, never remove protection or pretend coverage.

2026-10-16 publication ruling: Ship actual replacement production with the R3 owner/publication foundation in one integrated delivery. Current live append precedes write-behind durability; awaiting flush in the main model loop does not prevent UI, snapshot/fork or recovery readers from seeing a premature replacement. The writer must own seq/order, expected source/branch/protection, Stop before irreversible write issuance, durable receipt and uncertain-write reconciliation; pending candidate data stays outside active Session projection. A committed durable record survives Stop or a failed live switch and restores on load. Selection remains one contiguous eligible semantic span per pass, scanning beyond protected anchors rather than vetoing the whole tail.

The later asynchronous-publication ruling explicitly refines the original Stop wording: cancellation is checked before issuance, while visibility/recovery depend on durable commitment. One nonyielding owner turn validates Stop/source/fence and fixes transaction/seq/bytes before issuing the asynchronous write. Once issued, only that same transaction may finish or reconcile after Stop; no new model, wake or replacement authority follows. Unknown write outcome quarantines allocation/continuation; matching issued bytes can be synced, proven absence after Stop cancels without blind resend. This is an explicit contract amendment, not a claim that issuance already proves durability or that current product code implements F3. The wider integrated gate keeps private candidates out of every active reader until receipt.

## R1A public DTOs and pure API

Lives in `@i-harness/core-session`, which does not import agents, providers, tools, compaction or the future engine. New modules are `conversation/{types,sources,visibility,legacy,project,render}.ts`; split a cohesive helper further only when the responsibility/size requires it. `projection/messages.ts` becomes the existing API facade. Exactly one production fold remains.

```ts
interface ConversationSourceRef {
  id: string;                  // stable owner + seq + part; opaque, never authority
  eventIndex: number;          // position in this source archive
  seq?: number;               // durable address only when uniquely valid
  part: string;               // message/call/result/image companion
  addressable: boolean;       // false for missing/duplicate legacy seq
}
interface ConversationProvenance {
  kind: 'human' | 'plugin' | 'tool' | 'child-report' | 'model' | 'summary' | 'inherited' | 'unknown';
  authority: 'request' | 'observation' | 'derived' | 'unknown';
  scope: 'turn' | 'session';
  evidence: readonly ConversationSourceRef[];
  producer?: string;
  originSessionId?: string;
}
interface ConversationCall {
  callId: string;
  name: string;
  call?: ConversationSourceRef;
  result?: ConversationSourceRef;
  dispatch?: ConversationSourceRef;
  outcome: 'pending' | 'success' | 'error' | 'not-dispatched' | 'unknown';
}
interface ConversationItem {
  id: string;
  kind: 'input' | 'summary' | 'exchange' | 'legacy-fragment';
  sources: readonly ConversationSourceRef[];
  provenance: ConversationProvenance;
  messages: readonly LLMMessage[];  // exact existing semantic shape + native sidecars
  exchange?: {
    id: string;
    step?: ConversationSourceRef;
    acceptance: 'legacy-inferred' | 'explicit';
    state: 'open' | 'closed' | 'unresolved';
    calls: readonly ConversationCall[];
  };
}
interface ConversationDiagnostic {
  code: 'orphan-result' | 'duplicate-call-id' | 'duplicate-source-seq' | 'missing-source-seq' | 'invalid-source-seq' |
        'missing-admission' | 'partial-exchange-shadow' | 'unaccepted-dispatch';
  sourceIds: readonly string[];
}
interface ConversationProjection {
  version: 1;
  ownerSessionId?: string;
  archiveEventCount: number;
  throughSeq?: number;
  items: readonly ConversationItem[];
  diagnostics: readonly ConversationDiagnostic[];
}
function projectConversation(session: Session, options?: {
  ownerSessionId?: string; throughSeq?: number
}): ConversationProjection;
function renderConversation(projection: ConversationProjection): LLMMessage[];
```

R1A returns newly owned/frozen metadata, but does not claim a complete immutable capture of arbitrary legacy `unknown` argument objects; R1C freezes a validated request snapshot. `renderConversation` returns a fresh array and fresh message/container objects; it never mutates original events or the projection. No fake hashing of the entire raw archive. Identity may be owner-local when caller lacks a stable session ID; it must never serve as cross-session authority.

`messages` retain the existing ordered native continuation unchanged. Common projection does not reinterpret encrypted payloads, verify signatures, or replace protocol order with invented reasoning/text/call buckets. R2 adapters own native validity; R1A may report structural legacy diagnostics but must not strip sidecars or repair wire by inventing tool success.

Exchange grouping follows the repaired step-boundary semantics, including shadowed lifecycle markers and unconditional rewind exclusion. Parallel result order, tool-image companions and deferred mid-step reminder placement must be identical to current valid message output. Items representing a closed exchange include its tool-image companions; reminders remain separately attributed input items at their existing emitted position. Failed/unaccepted fragments remain raw evidence, not new accepted context. Stepless legacy call/results form an explicitly inferred group.

Provenance rules: matching durable admission with `intent:user`, no synthetic descriptor and no contradictory source can establish recorded human-request evidence. Plugin/internal/system/synthetic records are observations, known task display metadata is child-report, summary is derived. An unattributed legacy user role is unknown. Seed-range events under a child header are inherited even when their original admission was human; do not grant child-local authority. Inherited origin is recorded only to the precision available—never fabricate a parent seq after remapping. This is context provenance, not an authorization engine.

Known synthetic not-dispatched/unknown outcome error records remain those states. An arbitrary tool-result object containing a similar code string cannot become evidence of success; classify conservatively with error/dispatch/evidence and document ambiguity. Missing results produce open/unresolved metadata, not manufactured success. Diagnostics contain IDs/scalars only. Duplicate/missing/invalid legacy seq addresses can still be rendered compatibly but cannot be used as safe reduction addresses. Use event-index-qualified source IDs for unsafe coordinates; missing and invalid coordinates have their own diagnostic codes, never mislabeled duplicate.

R1A outcome ruling: metadata describes reported/structural evidence and never authorizes execution. A generic result with isError is error; a normal result is reported success. Canonical legacy unknown evidence (`isError:true`, output code `TOOL_OUTCOME_UNKNOWN`, `replay:false`) remains conservatively unknown, even when a legacy log lacks dispatch markers; this is not a certification of its producer. Code alone is insufficient. Not-dispatched additionally needs the matching error code, no matching dispatch and independent failed-attempt/boundary evidence consistent with the existing repair contract; contradiction with a dispatch yields unknown, absent evidence does not prove no effect. No result plus dispatch or a closed attempt is unknown; an otherwise open call can be pending, which asserts no known result, not no execution. The accepted cost of conservative classification is retaining ambiguous context longer rather than licensing replay.

## R1C capture and observation rulings

The [R1C execution plan](../plans/2026-10-16-context-engine-r1-snapshot.md) fixes the public snapshot/coordinate shape and real request consumers. Supported model-visible data is owned JSON-shaped data plus the existing JSON/native/image sidecars. Unsupported classes/accessors/cycles cannot acquire a false immutable guarantee or silently fall through to mutable execution; they produce a bounded CONTEXT_SNAPSHOT_UNSUPPORTED result before prepare/transport. Supported-data custom clients keep the existing neutral-only seam measurement. Payload validation precedes source stringification or unknown outcome-field access; invisible audit data is not copied just to build an active snapshot.

Protection is a pure core-session derivation shared by live and cold readers, based on effective owner-local turn, input/image, inbox and unsettled facts. It does not protect every completed exchange within a turn or infer a child turn from its parent seed. Pending input and turn closure may invalidate protection without altering model-visible text. Ordinary archive-only observations do not change semantic identity.

Measured request identity remains fixed in optional strict scalar requestContext fields. A separate postResponseContextRevision may record the state observed after accepted output; it cannot rewrite the identity of the measured request. Live/cold reads preserve historical measurements with admission unavailable when freshness is absent, and never trigger model resolution/auth/preparation to obtain missing evidence. Captured binding metadata, not a later live getter, attributes accepted usage. Existing BudgetPolicy decisions remain single-owned until R2 replaces them.

## R1B–R1D constraints to preserve while implementing R1A

- Format3 will add a non-ignorable `conversation/semantics` fence and accepted exchange records referencing existing assistant/call event seqs. Before the fence use legacy inference; after it require explicit accepted response. Header upgrade alone must not reinterpret old history. Exact write/read/seed schema is fixed in the R1B plan before editing.
- Acceptance requires an explicit complete end, not merely an exhausted iterator. Failed/truncated/refused attempts stay audit-only; existing unknown effects remain unknown. Tool executor remains the only dispatch owner.
- New root human API admissions and delegated/system admissions must be distinguished. `isSubagent`/synthetic/host provenance cannot be stamped as fresh human authority just because `run(string)` was used.
- Snapshot identities distinguish archive cursor from model-visible semantic revision and pending-input/protection revision. Budget/usage/telemetry events do not invalidate semantic identity. Newly accepted tool/child facts do, even when text coincides.
- Protect exact active inputs, host instructions, genuinely open/unsettled exchanges and pending admissions/delegations. Do not protect every completed step since turn/start; a long single turn must remain reducible.
- Eligible reduction is whole typed groups with a policy-sized recent tail. A protected item is a boundary, not a veto on all later groups. Summary source rendering uses selected item/source IDs, never `deriveMessagesUpTo(max(selectedSeq))` for a non-prefix selection.
- Positional replacement preserves protected anchors and typed retained tail; source coverage and insertion position are explicit. Only a committed record affects active view. R3 supplies full CAS/uncertain-commit/suffix transaction semantics under the same persisted model, not a competing projector.
- Existing incomplete account/route binding evidence stays partial until R2's resolved identity producer. No native cross-account or cross-route reuse is certified merely from matching model names.
