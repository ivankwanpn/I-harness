# Passive Code Mode semantic inheritance specification

Status: candidate closing review B1–B5 and the nested-candidate Important correction; documents only, not implementation/writer authorization. Prior packets/reviews remain unchanged. Product stays0.1.13-rc.1. This repairs child7→8→grandchild8/source7 with secret undefined, not C2 work or an oracle waiver.

## 1. Scope and chronology compatibility (B1)

The new passive export applies ONLY to actual held public-fork `{kind:'completed',atSeq?}` capture. Existing export calls without the new internal option, including all/last-turns/none and anonymous labels, keep their conversation-only behavior; none remains no seed. A label alone cannot opt into passive ownership.

Preserve `code-mode/src/state.ts`'s raw replay verbatim in a shared pure evaluator: terminals are last in ARRAY order; a completed terminal must have seq>write.seq ONLY WHEN BOTH seqs exist. Missing-seq completed-before-write and defined completed(seq10)-before-store(seq5) retain their existing positive results. Rewind/ownership/version/entry checks and genuine old raw-prefix inheritance remain unchanged. Never run that API through a positional tape adapter by assumption.

The positional tape theorem applies to held order-consistent capture, separately established by source: immutable F1 `fork-inline-host.ts:createForkSourceWitness` obtains `openManagedDocument`; `coordinator/managed-documents.ts:open` calls loadOwned, checks journal.eventCount===events.length, then attaches. `load.ts:loadOwned` fills missing seqs, rejects any defined seq!==index and durably canonicalizes before returning. `managed/groups.ts:resolveFactGroup` assigns subsequent seq=firstSeq+position; managed views freeze owned events. Cached/bootstrap documents use the same constructor/seq admission; pending bootstrap cannot assertReady. An arbitrary SessionView/source label establishes none of this.

The new internal factory additionally checks descriptor-safe seq===index on the actual held view and `isManagedFactOwner(view,owner.factOwner)` before tape capture; its assertion calls the held witness/current host guard before and after synchronous capture. Miswired nonheld inputs refuse source-unsupported, without changing raw runtime semantics. Existing loadOwned normalization/rejection remains the public legacy admission owner; do not add source repairs or reinterpret an unsealed legacy view inside export. Test this actual acquisition path, not only the local predicate.

## 2. Exact internal selection/owner contract (B2)

Types below use actual core `SessionView`, `FactOwner`, `SeedSelection`, `SeedRefusal`, `SeedTurnDomain`, `TurnExtent`, `SeedOmission`, `HistoryItem`, `ConversationDiagnostic`, and `historyTurns`; imports are from their existing core source owners. New types/functions stay on the internal bootstrap composition leaf; core never imports persistence/Code Mode/runtime.

```ts
type CompletedSelection = Extract<SeedSelection, {kind:'completed'}>;
type Coordinate = Readonly<{index:number; seq:number}>;
type Upper = {kind:'before-event'; at:Coordinate} | {kind:'archive-end'; eventCount:number};
type InheritedLatest = {kind:'empty'} | {kind:'latest'; manifest:Coordinate};
type Boundary =
  | {kind:'local-completed'; lastTurn:number; end:Coordinate; upper:Upper; inherited:InheritedLatest}
  | {kind:'explicit-inherited-group'; lastTurn:number; group:Coordinate; ordinal:number; upper:Upper;
      inherited:{kind:'empty'}|{kind:'completed'; manifest:Coordinate; turn:number}}
  | {kind:'inherited-default'; lastTurn:number; upper:Upper; inherited:InheritedLatest};
interface HeldSeedOwner {
  kind:'held-public-fork'; sourceSessionId:string; view:SessionView;
  factOwner:FactOwner; assertCurrent():void;
}
interface SelectedSeedHistory {
  kind:'selected'; groups:readonly {extent:TurnExtent;items:readonly HistoryItem[]}[];
  omissions:readonly SeedOmission[]; omittedInputs:ReadonlyMap<HistoryItem,number>;
  inheritedOmissions:readonly {ordinal:number;omission:SeedOmission}[];
  turns:SeedTurnDomain; diagnostics:readonly ConversationDiagnostic[]; rebase(extent:TurnExtent):TurnExtent;
}
interface OriginalWindow {cutFrom:number;markerSeq:number;markerIndex:number;startRank:number;endRank:number}
interface SelectionSource {
  view:SessionView; coordinates:readonly Coordinate[]; turns:ReturnType<typeof historyTurns>;
  history:ReturnType<ConversationValidationIndex['history']>; originalWindows:readonly OriginalWindow[];
}
interface CompletedPassiveContext {
  kind:'completed-passive'; owner:HeldSeedOwner; selection:CompletedSelection;
  source:SelectionSource; first:1; last:number; selected:SelectedSeedHistory; boundary:Boundary;
  groups:readonly {ordinal:number;extent:TurnExtent;establishments:readonly Coordinate[];anchor:Coordinate}[];
}
type ContextResult = {kind:'ready';context:CompletedPassiveContext}|{kind:'refused';reason:SeedRefusal};
function createCompletedPassiveContext(owner:HeldSeedOwner, selection:CompletedSelection):ContextResult;
type PassiveExportOption = {kind:'public-completed-passive';owner:HeldSeedOwner};
function exportConversationSeed(view:SessionView,label:SeedSourceLabel,selection:SeedSelection,
  passive?:PassiveExportOption):SeedExport;
```

`ConversationValidationIndex` is the actual existing validation.ts interface. Factor one SelectionSource builder from existing selection/index/historyTurns owners; `selectSeedHistory` and this factory reuse it. Return the existing selected fields with their same meanings. No host/executor second walker or rendered-text inference. Coordinates are source array indexes and sealed seqs; rank is the exclusive count of source records preceding a numeric boundary, clamped to0..eventCount. OriginalWindow is collected from each original rewind/point using existing defensive numeric/anchor<seq rules BEFORE interval melding.

Persistence's first callback constructs owner from actual ForkSourceWitness: view=source.view, factOwner=source.document, sourceSessionId=capture.core.sourceSessionId, assertCurrent calls handoff.guards.assertCurrent plus source.assertUnchanged. Export checks view identity and session label equality; no scalar becomes an execution grant. It passes the option into the SAME original export→compile→BootstrapRequest callback, never after READY or on retry.

Boundary decisions are closed: local absent atSeq→latest recorded end; in-range request→first end at/after request, otherwise no-completed-boundary; beyond archive→latest end. Refuse wholly unframed raw source with no completed boundary. Retain current B1 manifest/spanning/unframed-group ambiguity and straddling refusals; fix the independent in-range unfinished fallback explicitly.

For local-completed, upper is the next turn/start or archive-end; BOTH write and terminal selection use it. For explicit inherited-group, upper is before bootstrap completion at index header.seedLength, excluding all new local tail; inherited completed lookup uses that group's completed turn. For inherited-default with no local end, upper is before first new local turn/start or archive-end, including committed unframed local tail; inherited lookup is latest. V1/absent passive uses empty inherited lookup; old raw-prefix events remain raw candidates under their original predicate. Code-only completed framing with zero groups is valid and carries latest in a manifest.

Each group's establishments is its items' `HistoryItem.establishmentIndex` coordinates, in compiled group order; anchor is the earliest SOURCE establishment, not coverage/provenance origin or rendered position. A summary uses its own establishment. An inherited source group anchor composes through its stored alias; first/last are original ordinals and selected.turns is the actual rebased domain. Retained one-turn completed aliases use existing completed ordinals; no synthetic historical addresses.

## 3. Compact passive wire representation

```ts
type Cut = number;
type StoreEntries = readonly (readonly [string, CodeStoreJsonValue])[];
type CodeStoreJsonValue = null|boolean|number|string|CodeStoreJsonValue[]|{[key:string]:CodeStoreJsonValue};
type DataRow = {kind:'put';unit:number;key:number;value:number}
  | {kind:'touch';unit:number;key:number}|{kind:'eligible';unit:number;value:boolean};
interface PassiveCodeStoreV1 {
  version:1;units:number;keys:readonly string[];values:readonly {valueJson:string}[];rows:readonly DataRow[];
  cuts:readonly {end:number;overLimit?:true}[];latest:Cut;
  completed:readonly {turn:number;cut:Cut}[];groups:readonly Cut[];
}
type SemanticSeedV2 = Omit<SemanticSeedV1,'version'|'selection'>&
  {version:2;selection:CompletedSelection;passive:{codeStore:PassiveCodeStoreV1}};
type SeedHeaderV2 = Omit<SeedHeaderV1,'version'|'codec'>&{version:2;codec:'semantic-seed-v2'};
type SeedManifestV2 = Omit<SeedManifestRecord,'version'|'codec'|'selection'>&
  {version:2;codec:'semantic-seed-v2';selection:CompletedSelection;passive:{codeStore:PassiveCodeStoreV1}};
type StoreReplay = {kind:'value';entries:StoreEntries}|{kind:'limit-exceeded'};
type DeferredValueSlot = {kind:'local-descriptor';slot:number;eventIndex:number;entryIndex:number;value:unknown}
  | {kind:'inherited-json';slot:number;valueJson:string};
type CandidateRow = {kind:'put';unit:number;key:string;slot:number}
  | {kind:'touch';unit:number;key:string}|{kind:'eligible';unit:number;value:boolean};
type CutKnowledge = {kind:'unclassified'}
  | {kind:'inherited-observation';oldCut:Cut;outcome:'value'|'limit-exceeded'}
  | {kind:'classified';outcome:'value'|'limit-exceeded'};
interface OwnedPassiveCandidates {
  units:number;rows:readonly CandidateRow[];slots:readonly DeferredValueSlot[];
  cuts:readonly {end:number;knowledge:CutKnowledge}[];
  inherited?:{data:PassiveCodeStoreV1;toCandidate:readonly {oldCut:Cut;candidateCut:Cut}[]};
  latest:Cut;completed:readonly {turn:number;cut:Cut}[];groups:readonly Cut[];
}
interface PrivateCutRebase {toRebased:readonly {candidateCut:Cut;rebasedCut:Cut}[]}
function projectPassiveCodeStore(context:CompletedPassiveContext):OwnedPassiveCandidates;
function capturePassiveCodeStore(candidates:OwnedPassiveCandidates):PassiveCodeStoreV1|undefined;
function replayPassiveCodeStore(data:PassiveCodeStoreV1,cut:Cut):StoreReplay;
function replayLegacyCodeStore(view:SessionView,ownerId?:string):StoreEntries;
function semanticSeedFromRecords(header:SeedHeaderV1|SeedHeaderV2,
  records:readonly SessionEventView[]):SemanticSeedV1|SemanticSeedV2;
```

Candidates are private synchronous capture-lifetime structures: wrappers/metadata are owned; local-descriptor.value is deferred, not permission to traverse it. Inherited-json preserves the exact string verbatim, parsing/validating only when selected; never invent a local event/entry or encode valueJson as a user string value. Imported touch stays value-free. inherited.data is a captured metadata/string DTO, not a source event/body link. No candidate/source reference escapes capture into B2/host state; source/view stays untouched.

Carry ordered old-cut→candidate-cut→rebased-cut maps privately. Normalize raw windows and resolve the EFFECTIVE inherited cut through ordered min before assigning inherited-observation knowledge; do not attach an old fault to a changed landmark blindly. Rebase latest/completed/groups through these maps. Distinct landmarks remain distinct even with equal end or equal outcome; references already naming one cut may share it. No persisted origin/session/observation IDs and no end-only deduplication.

Units are dense anonymous correlations, reassigned every capture with no reverse map; inherited/local units are disjoint. A terminal contributes only boolean eligibility, not source status/IDs. At cut, select each unit's last transition; a put/touch qualifies only if true AND transition position>row position. Fold puts in original store/entry order; touch preserves insertion order and supplies no value. Every touched key at a nonfault exposed cut must have a final qualifying put. Raw legacy replay retains its separate seq-optional predicate above.

valueJson is the existing strict bounded encoder's exact normalized native JSON string on descriptor-safe owned data. JSON.parse plus strict-data validation and exact re-encode equality rejects duplicates/nonencoder spellings; no caller getter/toJSON runs. B2 canonicalization sorts DTO fields but cannot reorder characters inside strings, preserving nested member order. Keys/__proto__/origin/codec/native-looking objects remain literal opaque JSON; never Object.assign their members into prototypes or inspect them for artifact/native dependencies.

## 4. Typed source opacity and selected validation (B3)

Include `events/conversation-source.ts` in the owner slice. Its current recursive metadata traversal reaches code/store.writes[*][1] before pruning; replace ONLY the typed code/store source branch. Keep ordinary full durable intake and all other typed source validators unchanged.

First inspect event own descriptors safely for type/seq/owner/cell coordinates required by grouping/ownership; preserve existing source header metadata checks. Treat code/store version/writes payload descriptors as deferred, not recursively visited unknown metadata. Compute ownership, rewind visibility and last-terminal eligibility at all retained cuts before entry validation. Foreign/ineligible records gain no new version/entry-shape refusal.

For a store eligible at ANY retained cut, inspect version===1; writes must be an ordinary dense array; each pair must be an ordinary dense two-element array; key slot must be own enumerable DATA with string value; value slot must be own enumerable DATA. Array/pair/key/slot proxies/accessors/symbols/extras are refused without execution. Validate every eligible entry/version even if overwritten; malformed eligible keys cannot silently vanish. Do not broadly skip arbitrary user fields named writes/value.

Nested value bodies are opaque until a final-value role needs them; an eligible superseded cyclic/non-JSON/getter-bearing body can become touch without traversal. A VALUE-SLOT getter is malformed entry shape and refuses even when superseded. A selected final body is captured with existing descriptor-safe captureSelectedData rules and strict original-byte encoding; malformed selected JSON is invalid-seed, never overflow. Validate all retained wire values regardless of a queried fault flag.

## 5. Rewind, cut identity, pruning and faults (B4–B5)

Translate EACH ORIGINAL rewind window to inherited expanded-tape/local chronology, then use the existing core union rule and erase both puts/transitions inside windows. Rebase all cut landmarks, retaining post-marker commits. Translating already-melded physical cuts is wrong: group aliases8 then3, rewind group1 then group0, would otherwise resurrect3..8. Replacement reordering makes nonmonotone aliases possible; do not reject them.

After current-branch normalization, completed p and group rewind q are prefixes of ONE chronology; evaluate at min(p,q), recomputing last eligibility there. Min uses original ordered CUT ID, never group ordinal or end alone. Concurrent subset (put A, put B, B:true, cut, A:true), failure revival (put A,true,cut,false), and terminal-before-later-put all follow exactly for sealed input. Multiple middle-era raw windows are normalized first; global earliest-anchor truncation would wrongly discard new branch commits.

The retained alias set A is latest, each still-addressable retained one-turn completed boundary, and every compiled group rewind anchor. At every NONFAULT A mark earliest qualifying put/key for order and last for value; keep their union. Replace earliest-only put with touch to discard obsolete large JSON without reordering keys. Keep last relevant eligibility per unit before each A, preserving its relative position; repeated true cannot be merged across a relevant put. Remove unused values/keys/units/cuts and renumber. Nested capture repeats this on inherited+local data; summaries can eliminate addresses, not latest committed state.

Classify NEW outcomes ONLY at capture using complete observable data and the actual strict original-byte encoder (>4,194,304 means overLimit); retain existing inherited observations without pretending to re-prove discarded bytes. Unclassified is NOT ordinary empty, and no unclassified cut may reach pruning's omission decision or the wire. Malformed selected JSON is refusal, never overflow. The wire validator verifies closed flags/index/order/touch invariants, digests and ALL retained JSON, but cannot independently recompute discarded overflow-only bytes. This is observation data, not new authority/readiness proof.

New combined classification is exact: a min query that selects a known inherited landmark copies that landmark's value/fault observation. A new local-tail cut after an ORDINARY inherited latest uses its complete inherited replay plus qualifying local updates and fresh full-entry-array encoding. A newly exposed cut whose effective inherited base is fault retains that fault when no qualifying local puts change it; local eligibility-only rows cannot change disjoint inherited units. Later cuts selecting a different ordinary inherited base are classified independently, never poisoned by the earlier fault.

Unavailable-data counterexample is explicit: pruned fault F could have meant {x:huge,y:1} or {z:huge,y:1}; both yield the same inherited overLimit observation. A purported completed local x=0 after selecting F could make the first ordinary but leave the second oversized. No algorithm can classify that new combined cut from this wire. Actual Code Mode admission AND commit restore/check currentStore before executing/persisting writes, so a fault base cannot generate such completed writes until an actual rewind selects an ordinary base. Prove both guards in qualification. If externally injected raw facts nevertheless present this unclassifiable combination, refuse NEW passive capture as invalid-seed; never guess empty/fault/partial data or recover ancestors. The existing raw legacy replay API/predicate remains unchanged; this is not a new raw-runtime reinterpretation or a blanket fault for later cuts.

Nested roundtrip must preserve touch(x),put(y,2),put(x,1),true as Map order x,y without the lost obsolete x body. It must also preserve inherited cut0={end:0,overLimit:true}, cut1={end:0}, latest1/groups[0] through project→capture→project→capture with no writes: group fault stays distinct, latest stays ordinary empty, and V1 omission remains forbidden.

replayPassiveCodeStore returns limit-exceeded BEFORE evaluating a partial tape at that exact flagged cut. It is not an eligibility transition, global poison or fault inherited by later cuts. Existing Code Mode restore maps it to `new Error('Session store transfer limit exceeded')`; no partial/undefined entries reach worker admission. Equal-end cuts with different faults retain distinct IDs/order through pruning and min. Touch completeness applies only to nonfault cuts. Cut/latest/completed/groups references are all retained/range-checked.

Omit passive/return undefined and emit V1 ONLY IF EVERY retained addressable outcome is ordinary empty, no fault and no needed witness. Latest-empty plus earlier7, rewind-nonempty or any overLimit MUST emit V2. None/zero groups/latest-empty are distinct cases. A new semantic child never manufactures an empty result to satisfy a positive.

## 6. Limits, model exclusion and compatibility

Keep maxStoreBytes default1,048,576 and configured floor/clamp1..4,194,304; reuse runtime/limits.ts:json as a factored core pure encoder, including actual decoded ENTRY ARRAY and merged-map check. Escaped valueJson wire bytes are not runtime quota. The target's actual lower config may refuse a complete inherited value; no new fork default quota, key-length cap, arbitrary turn/record cap or truncation.

Let C be retained distinct ordered cut LANDMARKS, L=1+completed.length+groups.length serialized alias SLOTS, R retained puts/touches, E eligibility rows, Bk/Bv distinct encoded key/observable value bytes. Payload grows O(Bk+Bv+R log(indexes)+E log U+C log(rows)+L log C), not K*G full maps. Equal targets can reduce C but never erase the G group slots; E is retained transition metadata, not proved linear in distinct outcomes. Valid cuts imply Bv=O(C*4MiB). Outer valueJson encoding is <=2B+2 per B native bytes plus framing; required distinct4MiB values are unavoidable. Measure bytes/CPU; no fixed whole-seed bound with unbounded retained cuts/aliases.

Passive lives in manifest BODY: preserve header<=65,536, stage<=262,144, seedLength=groupCount+1, exact seed/completion batches and birth keys/bytes. No new chunk/spill/registry or after-READY installation. Existing historyFact retains only structure; no new rendered items/provider messages. Only an explicit later bounded Code Mode query can place a value in tool output. No cell/worker/global/secret/tool/grant/delivery/native authority is copied; artifact closure remains solely the selected conversation artifact table.

Use SemanticSeedV2/semantic-seed-v2 with mandatory passive.codeStore, header+manifest version2, existing group schema1, same Session13/journal1/stage1. Dispatch/reconstruct from actual header+manifest version match. V2 source/seed digest domains include every passive field; unchanged dependency domain covers actual artifacts only. Preserve exact V1/empty constants, old birth/stage payload and original retries; never rewrite an existing V1 operation to V2.

Source proves old codec1 header rejects codec2 before repair: JSONL parseHeader→validateSubagentHeader→validateSeedHeader; direct repair parses before torn-tail rewrite, coordinator load/loadOwned preflight before backend.repair, core fromJSONL validates header before body. Session14 is not required solely for refusal. Actual compatibility evidence still requires a genuine unmodified FORMAT13/CODEC1 predecessor graph, isolated from current packages, against new codec2 ordinary+torn targets: refusal and zero repair/append/metadata writes with unchanged bytes. Also new-reader cold resume/reconcile genuine old V1 11/12/13 birth/stages byte-identically.

## 7. Owned file set, serial conflict reservation and acceptance

Core owner: new `projection/passive-code-store.ts`, `serialization/bounded-json.ts`, `conversation/passive-seed-context.ts`; existing `events/conversation-source.ts`, `projection/rewind.ts` (factor original windows without changing raw result), `conversation/seed-selection.ts`, `history/group.ts`/`turns.ts` (shared metadata), seed-types/capture/export/digest/codec, events/bootstrap/header and bootstrap-validation, managed/bootstrap/memory-bootstrap, index/internal exports. No duplicate history walker or core reverse runtime dependency.

B2 owner: semantic-seed compiler and coordinator/bootstrap-header capture/build/stage reconstruction; shared core `semanticSeedFromRecords(header,records)` handles V1/V2 for all callers. `coordinator/bootstrap.ts:checkBirth` currently hardcodes V1 and MUST switch to it, but that file is reserved by F1 HOST's cache-READY fix: only a root-released sequential rebase after that fix is accepted may touch this narrow reconstruction. `managed-document.ts` is EXCLUDED; do not edit its readiness/lifecycle. Audit durable fact-journal/birth consumers; keep frame layout unchanged. Code Mode owner: state/types/runtime limits factoring and existing restore adapter; register/assembly get no second store owner.

Acceptance requires unchanged original executor store oracle plus cold source-unavailable/nested controls; code-only and unframed tail; unfinished atSeq correction; unsealed/nonmonotone RAW runtime positives; actual held-source sealing/admission proof; concurrent/failure/repeated-terminal cases; metadata/body opacity; ordered JSON/__proto__/Map witnesses; equal-end fault/empty-latest revival; exact limits/overflow/corruption; replacement aliases/two rewinds; foreign/native/delivery negatives; identical real provider-message bytes without explicit query; once-only warm/passive/lost-response original payload; long-session size/CPU and genuine predecessor/V1 birth evidence. No test pass is claimed by this specification.

PC06 root ruling: KEEP conservative standalone requireRoot; an empty managed table cannot prove absent inherited L1 sidecars. The pure two-argument ordinary no-sidecar semantic baseline stays positive; seed-bearing nested convenience without an issued full host retains its typed host-required refusal. Migrate ONLY the original Code Mode integration fixture's fork COMPOSITION to the real reviewed shipping full host/controller, preserving every7→8→8/source7/global-isolation assertion; separately test standalone refusal. This is an explicit API-composition migration, not a data-loss waiver or empty-store replacement.

The core/B2/restore lane may first qualify actual same-owner primitives. Whole integrated positive waits for reviewed F1 full-host handoff (`session-executor/src/lifecycle/fork-handoff.ts`/actual CLI composition or accepted Gateway equivalent), never a fake host/raw fallback/retentionless marker. Reserve the shared original test until that handoff. No store-semantics decision remains; root's remaining dispatch decision is the accepted F1 BASE/release for the narrow bootstrap.ts reconstruction rebase and full-host fixture handoff. Root assigns the CURRENT owner in the matching plan ledger; the original HOST and later integration handoffs remain explicit gates.

## 8. New-code module boundaries

Keep projection/passive-code-store.ts a thin stable facade. Put cohesive private types, legacy replay, tape replay, capture and pruning in projection/passive-code-store/{types,legacy,replay,capture,prune}.ts. These modules implement the same interfaces above, with one selection/rewind owner and no duplicate history walker. The bounded JSON encoder and passive selection context keep their named owners. This is new-code organization, not resumption of deferred general file decomposition.

## 9. PC07 bounded persistence handoff

Root verified that checkBirth is byte-equivalent after LF normalization between accepted9d0c1a34 and independently reviewed FC12 fixd8b807e2 (SHA2569190f1f90c6a0cd287c045d0d388ad11f3feef3dc2c68d39212b089d2e58509c); semantic-seed.ts and bootstrap-header.ts are unchanged between those sources. The F1 writer confirmed its current copies match and released these codec/reconstruction slices. This closes the former Stage3 source-owner gate only: CURRENT may change semantic-seed.ts, bootstrap-header.ts and bootstrap.ts:checkBirth plus its necessary import. It must not copy, replace or edit FC12 cache/run/lifetime/managed-document logic or its F1-dependent fixture. Root composes the frozen FC12 and codec deltas serially and qualifies both on the eventual integrated source. Scoped FC12 approval is not a claim that it has landed in MAIN. Stage6 full-host/controller/original public-positive handoff remains gated.
