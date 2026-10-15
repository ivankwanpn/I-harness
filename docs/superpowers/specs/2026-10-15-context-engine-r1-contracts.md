# R1 semantic conversation and snapshot contracts

Approved architecture: [ContextEngine](2026-10-15-context-engine-redesign.md) and [framework](2026-10-15-context-engine-framework.md). User authorized implementation2026-10-15. This document fixes the data-layer interfaces before product edits. Phase execution continues without another approval prompt.

## Delivery sequence

1. **R1A**: one semantic conversation projector with source/provenance and exchange metadata; old message APIs become facades, valid wire behavior preserved.
2. **R1B**: format3 semantics fence, explicit accepted response facts and trusted input provenance; flush acceptance before effects; seed/reference and legacy format migration.
3. **R1C**: immutable ContextSnapshot and real core-agent request/freshness consumer; separate archive/semantic/protection/branch/context/binding identities.
4. **R1D**: structural complete-exchange selection and positional replacement record/rendering, consumed by existing compaction entry points. R3 later owns full transactional publication/attempt budget; no new interim append-position summary behavior is introduced for non-prefix selections.

Each delivery receives its own concrete task plan, tests and independent review. S20/CX full decomposition credit requires their complete separate gates; touching an admission or backend helper here is not completion credit.

Ruling: Pull positional replacement DTO/rendering into R1D — protecting current human inputs while reducing closed steps in the same turn requires non-prefix selection, and the old prefix-summary replay would include protected inputs or misplace the result — if wrong, limit migration to a known safe contiguous eligible span and keep blocked diagnostics, never remove protection or pretend coverage.

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
  code: 'orphan-result' | 'duplicate-call-id' | 'duplicate-source-seq' |
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

Known synthetic not-dispatched/unknown outcome error records remain those states. An arbitrary tool-result object containing a similar code string cannot become evidence of success; classify conservatively with error/dispatch/evidence and document ambiguity. Missing results produce open/unresolved metadata, not manufactured success. Diagnostics contain IDs/scalars only. Duplicate/missing legacy seq addresses can still be rendered compatibly but cannot be used as safe reduction addresses.

## R1B–R1D constraints to preserve while implementing R1A

- Format3 will add a non-ignorable `conversation/semantics` fence and accepted exchange records referencing existing assistant/call event seqs. Before the fence use legacy inference; after it require explicit accepted response. Header upgrade alone must not reinterpret old history. Exact write/read/seed schema is fixed in the R1B plan before editing.
- Acceptance requires an explicit complete end, not merely an exhausted iterator. Failed/truncated/refused attempts stay audit-only; existing unknown effects remain unknown. Tool executor remains the only dispatch owner.
- New root human API admissions and delegated/system admissions must be distinguished. `isSubagent`/synthetic/host provenance cannot be stamped as fresh human authority just because `run(string)` was used.
- Snapshot identities distinguish archive cursor from model-visible semantic revision and pending-input/protection revision. Budget/usage/telemetry events do not invalidate semantic identity. Newly accepted tool/child facts do, even when text coincides.
- Protect exact active inputs, host instructions, genuinely open/unsettled exchanges and pending admissions/delegations. Do not protect every completed step since turn/start; a long single turn must remain reducible.
- Eligible reduction is whole typed groups with a policy-sized recent tail. A protected item is a boundary, not a veto on all later groups. Summary source rendering uses selected item/source IDs, never `deriveMessagesUpTo(max(selectedSeq))` for a non-prefix selection.
- Positional replacement preserves protected anchors and typed retained tail; source coverage and insertion position are explicit. Only a committed record affects active view. R3 supplies full CAS/uncertain-commit/suffix transaction semantics under the same persisted model, not a competing projector.
- Existing incomplete account/route binding evidence stays partial until R2's resolved identity producer. No native cross-account or cross-route reuse is certified merely from matching model names.
