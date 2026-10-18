# ContextEngine R4A retained results implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this connected task, followed by fresh specification/quality review. Steps use checkbox (`- [ ]`) syntax for tracking. Read this COMPLETE document and its linked specifications, not only a generated checkbox excerpt.

**Goal:** Preserve complete large results under the existing storage policy while every model-facing result remains bounded, truthful and recoverable without executing its source again.

**Architecture:** Extend the existing Context Output workspace store with immutable, verified, pinned result artifacts. Core session owns the versioned result data and projection; core tools and the existing executor composition bind once-only finalization to the original F1 source. Normal tools, MCP, exec, Code Mode, child/job settlement and their readers cut over together. R4B semantic bootstrap and R4C delivery/claim ownership remain separate.

**Tech Stack:** Existing TypeScript/Node workspace packages, installed Vitest/TypeScript, Node file APIs and SHA-256, existing `@i-harness/fs-lock`, existing optional SQLite search. No new external package or service.

**Spec:** [approved redesign](../specs/2026-10-15-context-engine-redesign.md), [framework](../specs/2026-10-15-context-engine-framework.md), [retention decisions](../../research/2026-10-16-context-engine-r4-retention-preflight.md), [current-owner rebase](../../research/2026-10-18-context-engine-r4a-current-owner-rebase.md), and [decomposition mapping](../../refactoring/2026-10-15-context-decomposition-overlap.md).

**Status:** Ready for the next sole writer after root self-review, rebased to accepted R2E product9fb933f69627b015c086472bd2533e7ff7c8e0f2. The actual task BASE will be the documentation checkpoint containing this plan. R4A has not yet been implemented or accepted.

**Rebase:** Between the earlier source inspection221051b2 and accepted9fb933f6, the named tool/store/exec/MCP/task/report/capture ownership paths retain their APIs. The relevant changes are core-session format9/JSONL predecessor handling, core-tools context observation and core-agent automatic soft policy. Actual tool/result and code/result still have legacy raw output, so the new envelope cutover remains required. R4A advances9→10, covering literal9 and prior8 read/upgrade paths and actual downstream version fences. `softAdvances` is explicitly in the reader cutover; accepted E assessment/freshness/publication boundaries are preserved.

## Global constraints

- Existing branch `codex/v0.1.13-development`, workspace `D:/I-harness-main`, version0.1.13-rc.1. One product writer; all delegated work GPT6.1Sol. Root owns architectural rulings, review, evidence and checkpoints. No recursive agents, unrelated refactoring, live accounts/providers, merge/release or version change.
- Keep five protocol families and the distinct Codex subscription route; native state, typed media, bindings and actual final request admission remain owned by their existing adapters/F4/E owners.
- Full retention is mandatory for shipping large results independently of optional Context Mode/search enablement. Preserve512MiB default total disk quota and its configuration. No second raw-result store or hidden quota growth.
- Initial model text/envelope limit64,000 **serialized UTF-8 bytes**; child preview2,048 **serialized UTF-8 bytes**; aggregate report16,384 **final JSON UTF-8 bytes**. Current typed-media limits remain separate. Metadata and JSON escaping count.
- Preserve original tool/body/finalize/post-tool order and F1 exact source/capture/receipt ownership. Storage recovery may resume unfinished storage phases only. It cannot rerun tool bodies, getters/toJSON, completed hooks, guest invocations or model requests.
- New content is visible through an immutable ref only after confirmed artifact commitment. Unknown artifact or document publication retains its original operation and conservative pin. A path, JSON-shaped ref or copied opaque handle grants no authority.
- Document-lifetime pins protect new managed results/grants, including archived or rewound history and uncertain publication. Only confirmed deletion of that document releases its pin; other owners remain. Generic clear/TTL/quota GC cannot delete pinned or unknown objects.
- Tests/scripts are not decomposition targets. New product responsibilities use focused sibling modules, with no new giant closure or renamed monolith. S25 and CX2 overlap must retain one owner; splitting is credited only after the complete original responsibility and gate are delivered.
- No audit exemptions, reachability reseeds, fake consumers, unchecked `any` ports, hidden warnings or replacement production mocks. Necessary direct dependencies on existing workspace packages and coherent lock importer rows are permitted only with an acyclic actual graph.

## Current files and responsibility destinations

Paths in this plan are relative to repository root. New leaf names below define responsibilities; a leaf may be consolidated with an existing equivalent owner when the implementation report records the exact mapping and no second owner results.

| Existing owner | New/changed responsibility |
| --- | --- |
| `packages/core-session/src/events/{types,intake}.ts`, `managed/{capture,settlement-event}.ts`, `projection/messages.ts`, serialization/version readers | New closed result-envelope data; structural call binding; explicit legacy projection; next format fence; once-lowered payload and bounded serialization primitives |
| New `packages/core-session/src/results/{types,validate,projection}.ts`; `serialization/json-data.ts` plus sibling `serialization/json-stream.ts` | Browser-safe data/validation/projector contract; one JSON traversal/escaping implementation shared with existing string wrappers, without introducing Node I/O into these new DTO leaves |
| `packages/context-output/src/{types,service,store,tools,config,recovery}.ts` | Preserve public facade; split actual lifecycle/access/search ownership into siblings; mandatory result admission independent of optional indexing; preserve legacy read behavior honestly |
| New `packages/context-output/src/artifact/{types,manifest,index,writer,reader,ownership,recovery,quota}.ts` | Immutable body/index identity, complete writes/sync, bounded range integrity, workspace mutation lock, pins and same-operation recovery |
| `packages/core-tools/src/{types,index}.ts`, `registry/{dispatch,finalize,retained-outcome}.ts`; new `registry/result-finalization.ts` | Inject narrow retention port; trusted outcome/media handoff and private once-only finalization state bound to actual PreparedCall/source |
| `packages/output-retention/src/spill-guard.ts` and new `result/{capture,preview,media}.ts` | Shared once-lowered complete result and bounded model projection; remove shipping fail-open spill and guest-value replacement |
| `packages/core-agent/src/tool-batch/{record,types}.ts`; `packages/code-mode/src/broker.ts`, `broker/{records,types}.ts` | Reconcile finalization/storage independently from hooks/guest promise; commit envelope through original F1 capture; return program value to guest, model projection to history |
| `packages/mcp-client/src/bridge.ts` | Normalize complete McpCallResult before either isError presentation or loss of structuredContent; trusted outcome declaration and ordered supported media |
| `packages/exec/src/index.ts`, `capture/{output,retention,completion,contracts}.ts`, `jobs/{records,views,observation}.ts`, `retained-output.ts` | Inject trusted streaming sink; retain ordered raw frames before collector loss; immutable result revisions in jobs; preserve process/cancel/stream-consumer semantics |
| `packages/session-executor/src/context-output.ts`, `lifecycle/{result-references,reference-retention}.ts`, existing assembly tool/exec/context wiring | One workspace store composition; exact source/document pin settlement; remove optional lossy capture as mandatory-result owner; preserve inheritance grants and current source visibility |
| `packages/subagent/src/{task-protocol,persist,jobs,job-facts,report-policy,task-notification,projection}.ts` and existing child/team completion callers | Ref-backed new bodies and revisioned bounded rows; split task protocol into cohesive `task/` leaves with one records/outbox/save owner; no full body repetition in result/outbox/report metadata |
| `packages/desktop-gateway/src/session-subagents.ts` and its actual leaf callers | Ref-backed current/durable read projection with existing lineage visibility; no assembly/child creation on reads; complete S25 extraction if this owner is substantially changed |

All actual query/export/fork/SDK/CLI readers of changed event unions must handle the new envelope. R4A preserves their semantics and dependency descriptors; R4B alone changes semantic bootstrap and R4C alone changes result claim/wake semantics.

## Closed data and private runtime contracts

The following names are normative proposed public contracts for this gate; implementations may use type-only imports from the declared owner but may not introduce parallel schemas. Existing `ImageInput` and `validateImages` are in `packages/core-session/src/images.ts`; their current validators and size limits remain authoritative.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ResultOutcome = 'succeeded' | 'failed' | 'canceled' | 'unknown';
interface ResultExecution {
  outcome: ResultOutcome;
  dispatch: 'not-dispatched' | 'dispatched' | 'unknown';
}
type ResultCodec = 'json-utf8-v1' | 'text-utf8-v1' | 'exec-frames-v1';
type ResultCompleteness = 'complete' | 'source-limited' | 'capture-canceled' | 'producer-incomplete';
interface ManagedArtifactRef {
  version: 1;
  id: string;                 // ctxv1_ plus 64 lowercase hex, host-created
  revision: string;           // SHA256 of canonical closed manifest bytes
  codec: ResultCodec;
  encodedBytes: number;       // safe nonnegative integer
  contentDigest: string;      // SHA256 of exact encoded body
  completeness: ResultCompleteness;
}
type ResultRetention =
  | { kind: 'inline'; value: JsonValue; encodedBytes: number }
  | { kind: 'artifact'; ref: ManagedArtifactRef }
  | { kind: 'unavailable'; reason: 'quota' | 'encoding' | 'storage-refused' | 'unsupported-owner' | 'capture-canceled';
      observedEncodedBytes?: number };
interface ResultEnvelope {
  version: 1;
  execution: ResultExecution;
  preview: string;
  media: readonly ImageInput[];
  retention: ResultRetention;
}
```

Envelope identity is bound by the outer actual tool/code/child/job call and immutable result revision; no payload-supplied status is authoritative. New result facts carry an explicit envelope member discriminated from historical raw output. Validation rejects conflicting raw-output/envelope alternatives, unknown variants, accessors/prototypes, nonfinite/unsafe sizes, extra authority-like fields and an artifact's mismatched codec/count/digest. The format fence prevents old readers interpreting new facts as ordinary output. An absent envelope remains the deliberate historical branch, not a silent new-shipping fallback.

Small results may remain inline only when the COMPLETE final model/archive envelope satisfies its limit; avoid duplicating the value in preview. A ref's whole-content digest describes its declared encoding, not a fabricated original transport size. A text source with unpaired UTF-16 surrogates uses JSON encoding so its original JS value remains recoverable. Binary exec data is never represented as UTF-8 text without an explicit decoding view.

The actual `ToolRegistry` receives an optional narrow **trusted composition** result-retention port; mandatory shipping assembly always supplies it. Standalone callers explicitly remain nondurable or unsupported, never silently acquire disk guarantees. The result port is defined below core-tools/context-output's potential cycle, using core-session DTO types and core-tools runtime types; no core-tools→context-output import is allowed.

```ts
interface ResultFinalization {
  settle(): Promise<
    | { kind: 'ready'; envelope: ResultEnvelope; programValue: unknown }
    | { kind: 'recovery-required' }
  >;
}
interface ToolResultRetention {
  capture(prepared: PreparedCall, output: unknown, execution: ResultExecution): ResultFinalization;
  captureSynthetic(context: {
    view: SessionView;
    source: SettlementFacts<ProducerFactOutcome>;
    callId: string;
    name: string;
  }, output: unknown, execution: ResultExecution): ResultFinalization;
}
```

`capture` registers the original operation exactly once after the existing tools/post-execute phase. The returned implementation retains private phase state and immutable source identity. `settle` coalesces concurrent callers and reconciles the original artifact/fact identity; it is not permission to invoke the body or the tools/post-execute phase. Actual programValue is the once-lowered owned structured value, never the preview envelope. Its existing guest transfer cap still applies. A failed guest transfer does not delete the already committed host result.

Synthetic argument/lookup/pre-dispatch outcomes have no PreparedCall. `captureSynthetic` therefore takes the actual existing batch/Code Mode source and view (`SessionView`, `SettlementFacts` and `ProducerFactOutcome` are existing core-session contracts), validates their original managed registration/call association, and captures after the existing synthetic-result projection phase. Do not manufacture a PreparedCall, rerun prepare/approval or invoke normal body hooks to satisfy the API. Its finalization state is bound privately to that original source/slot. Both alternatives converge on the same once-lowered envelope/store owner; serialized or structurally forged source objects are rejected. Explicit nondurable sources retain their stated guarantee only.

The registry binds trusted outcome metadata to exact `ToolExec`/PreparedCall identity through a private registration, exposed to genuine built-in producers as a narrow function or callback. Ordinary return defaults to succeeded; actual thrown/aborted/synthetic outcomes and MCP's actual isError set the typed outcome. Objects containing fields named error/code/images/audio are data and cannot forge outcome, authority or full-retention handles. Both normal and Code Mode paths consume this same metadata; metadata is cleared only after its original settlement is retained/finished.

Dispatch disposition comes from the actual dispatch/source owner, not payload codes: failed argument/pre-dispatch cancellation can certify not-dispatched; a real returned tool body is dispatched; an interrupted unobserved effect remains unknown under the existing policy. New-envelope decoding and historical decoding meet in one result-disposition projection. Actual consumers include `core-session/src/conversation/history/facts.ts`, `conversation/render-items.ts` and `core-agent/src/agent/context-reduction/automatic.ts` (`softAdvances`). Update them so unknown effects neither become closed successful exchanges nor grant replay/cooldown progress merely because raw `output.code` disappeared. Preserve historical raw-code interpretation only in the legacy branch.

Runtime unknown artifact publication is **not** a ready ResultEnvelope: it returns recovery-required, protects its original required source and pin, and does not publish a ref. Known quota/encoding refusal can settle a bounded unavailable envelope while preserving the actual execution outcome. F1 unknown event receipt remains the existing captured fact's unknown state, independent of artifact status.

The new managed store methods are siblings of the existing optional capture/search API, owned by the same workspace service and quota. Runtime scope tokens below are private registered objects; structural TypeScript shape alone is never validation. The executor creates them only from actual document/source/call ownership and the store checks its registration before opening an operation. Public tools receive only bounded read DTOs, never mutation scopes or sink methods.

```ts
interface ResultArtifactScope { readonly operationId: string }
type ArtifactSettlement =
  | { kind: 'committed'; ref: ManagedArtifactRef }
  | { kind: 'refused'; reason: 'quota' | 'encoding' | 'storage-refused' | 'capture-canceled'; observedEncodedBytes: number }
  | { kind: 'recovery-required'; operationId: string };
interface ResultArtifactSink {
  write(bytes: Uint8Array): Promise<void>; // copies/binds each admitted bounded chunk before resolving
  finish(completeness: ResultCompleteness): Promise<ArtifactSettlement>;
  reconcile(): Promise<ArtifactSettlement>; // same original operation, never asks producer for bytes again
}
interface ManagedArtifactPage {
  ref: ManagedArtifactRef;
  offset: number;
  nextOffset: number | null;
  eof: boolean;
  data: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string };
}
interface ManagedArtifactMethods {
  beginResult(scope: ResultArtifactScope, codec: ResultCodec): Promise<ResultArtifactSink>;
  readResult(access: ContextAccess, query: { ref: ManagedArtifactRef; offset?: number; maxBytes?: number }): Promise<ManagedArtifactPage>;
}
```

`ContextAccess` is the existing context-output access contract. A JSON reconstruction of ResultArtifactScope fails registration. `operationId` is generated by the original trusted owner and bounded to128UTF-8 bytes; all persisted session/call/source identifiers use the current1024byte identity limit. Each authoritative operation/manifest/pin record is bounded to64KiB; store separate document pins rather than an unbounded owner-array rewrite. New registry methods must have actual composition callers and tests; no unused generic store API is added.

The narrow scope registration, document-pin receipt update and confirmed deletion release stay host-internal to existing lifecycle composition. Every update validates the same original document/source and expected operation revision; arbitrary serialized receipt fields do not prove F1 commitment. The store's operation lookup and metadata are authoritative across reopen, while runtime registrations cannot survive or manufacture execution authority. After cold reopen, the actual host may inspect/reconcile stored artifact operations and existing document references without invoking a producer again.

`readResult` provides raw verified encoded bytes for `exec-frames-v1`; a separate bounded codec adapter validates complete frame records and returns channel slices. It does not trust an arbitrary user byte offset as a frame boundary. Text/JSON pages are character-safe views of encoded text; they are not silently parsed into a complete giant object. Runtime returned read failures are bounded typed not-found/stale/unauthorized/corrupt/range/budget/unavailable dispositions through the actual tool wrapper, with no raw filesystem path or full source payload.

## Artifact format and bounded integrity

Managed results extend the existing workspace Context Output directory; use a versioned managed namespace with body, manifest, index and ownership records. Existing legacy captures retain their old schema and honest guarantees. All physical bytes share the existing workspace quota. Optional index/search state is rebuildable and cannot veto a confirmed managed ref.

Canonical manifest fields, in this order, are `version:1`, `codec`, `encodedBytes`, `contentDigest`, `completeness`, `chunkBytes:65536`, `leaves`, `paddedLeaves`, `treeRoot`. Each hash is64lowercase hex; manifest JSON is at most4096UTF-8 bytes. Its digest is the public revision. Completeness describes the capture scope independently of execution outcome, is declared by the actual source settlement and is immutable; reads return it through the verified ref. Owner/source/call/pin metadata is separate, bounded and cannot alter content identity.

Let `n=max(1,ceil(encodedBytes/65536))`, `p=2**ceil(log2(n))`, `nodes=2*p-1`. Every intermediate/file offset is checked as a safe integer before I/O; reject a body/quota configuration whose index arithmetic exceeds that domain. Index header is exactly64bytes:

| Offset | Encoding |
| --- | --- |
| 0–7 | ASCII `IHARTIDX` |
| 8 | u32be version1 |
| 12 | u32be headerBytes64 |
| 16 | u32be chunkBytes65536 |
| 20 | u32be reserved0 |
| 24 | u64be encodedBytes |
| 32 | u64be n |
| 40 | u64be p |
| 48 | u64be nodes |
| 56–63 | eight zero reserved bytes |

Following header: exactly `32*nodes` digest bytes in one-based heap order (node1 begins at64). Real leaf `i` is SHA256(`00 || u64be(i) || u64be(length) || chunk`); padding is SHA256(`02 || u64be(i)`); branch is SHA256(`01 || left || right`). Empty body has one real empty leaf. This follows R4A-INT-01; a mutable unrooted digest list is not equivalent.

Writer processes bounded chunks, streams whole-content SHA, and constructs on-disk tree levels/fixed offsets with bounded working buffers. It must reserve/charge body, tree, manifest, authoritative pin/operation records and temporary physical storage before each increase. No all-body Buffer, all-digest JS list or second full body copy in finalization. Full checked writes and file sync precede publication. Account for transient metadata replacement; a quota refusal may not evict another protected result.

Reader validates current caller/workspace/source visibility and exact ref/revision before body I/O. It validates bounded manifest/header arithmetic, then touched chunks plus sibling paths against treeRoot. A32KiB page over a100MiB artifact must read no more than its touched64KiB chunks, their O(log p)32byte siblings, fixed header and bounded manifest/ownership metadata; it may not hash/read100MiB or load all leaf hashes. A full original-digest verification is a separate explicit streamed operation used by controls/import, not each page.

Use the existing workspace mutation authority to bind the ACL/pin revision checked for a page; recheck revocable host visibility before returning after asynchronous I/O. Reject link/path substitution outside the owned artifact root and changed file identities. A missing/corrupt optional search index cannot substitute for these checks.

Default read cap stays32KiB and counts the final serialized result envelope. Text byte cursor starts on a UTF-8 boundary; mid-codepoint starts refuse, end backs down to a full codepoint, and a non-EOF page must advance. Metadata that leaves no room returns a bounded explicit refusal. Binary pages use base64 chunks and byte cursors under the same JSON cap. `exec-frames-v1` reader exposes ordered channel/frame slices, never claims an arbitrary binary range is text. No ref resolution implicitly fetches remote resource URIs.

`exec-frames-v1` body starts with9ASCII bytes `IHEXEC01\n`. Each subsequent record is a canonical JSON line with these fields in order: `channel` (`stdout` or `stderr`), `frame` (safe nonnegative original ordinal), `offset` (safe nonnegative byte offset in that original frame), `end` (whether this is its last slice), `data` (canonical padded base64 of at most32768raw bytes), then LF. One encoded record including LF is at most45056bytes; empty native frames may be skipped while original ordinal still advances. Validate sequential frame/part progression at capture. Binary is base64 inside this codec, not model preview prose; its expansion counts against physical quota.

A codec page cursor carries an encoded record offset and decoded slice offset. Validate the header at0, an offset immediately after a verified LF (the only unescaped LF positions in this encoding), the next bounded canonical record and slice range. A cursor in a record refuses instead of scanning backwards or through the100MiB body. An arbitrary payload substring cannot masquerade as a record boundary because canonical base64/JSON field values contain no literal LF. A page may decode at most its bounded requested output plus one bounded boundary record; record reads use the same rooted chunk proofs. It returns ordered channel/frame slices as base64; optional text is emitted only for a strictly valid UTF-8 slice and marked as a view, never substituted for raw bytes. End-of-stream/exit/cancel/completeness remain trusted bounded settlement facts bound with the result; stopped capture cannot claim complete output. The extra bounded record work is recorded separately from the generic raw-page I/O bound.

## Ownership, lifecycle and recovery

Use existing `acquireSessionLock`/`lockPathFor` for the workspace store's qualified Windows/Linux mutation ownership. It is distinct from the session lock. No weak PID lock fallback; unsupported owner platforms report unsupported retention. Serialize quota-changing writes/grants/releases and record pending reservations. Do not hold a session sequence-allocation lane while writing100MiB.

The private operation phases are `registered → capturing → staged → artifact-committed/pin-pending → fact-captured → fact-committed → settled`. A state may be uncertain at an issued storage boundary; keep its exact original operation/ref/digest and reconcile rather than recapture. Operation metadata is bounded and separately synced. A confirmed artifact+pending document pin precedes any result fact that contains its ref. A crash between stores leaves protected storage, not an invented distributed atomic transaction. Reconciliation can prove the exact original publication committed, absent/unissued or still unknown. Absence after Stop cannot grant a new tool/summary/wake action.

Artifact completion callbacks only mark existing ownership. Required F1 source closure waits for original artifact/fact settlement; post-tool hooks are not re-executed. Normal batch stores the finalization handle separately from its transient settled Promise. Code Mode must also separate its cached guest completion from storage reconciliation: a rejected cached guest Promise is not the only recovery handle, and a retired cell never receives a second fulfillment.

Source/ACL revocation denies reads but leaves storage pins intact until authorized release. Generic clear returns an explicit bounded protected-count/disposition; it cannot remove pinned or unknown artifacts. Confirmed document deletion releases only that document's pins. Header/index loss yields missing/corrupt disposition with no false full result; optional SQLite index loss leaves managed reads usable. Cold managed-store open reads bounded authoritative metadata without full-body hashing/reindexing. Search uses a bounded optional preview/index budget and reports partial coverage.

## Integration and old-path retirement

1. **Structured normal output:** lower legacy JSON semantics once before a storage allocation lane; stream encoded chunks, build bounded preview and owned program value in that traversal. Reuse one escaping/traversal implementation with current stringify wrapper; no independent encoder with different source/property order. Preserve source-order keys, sparse arrays, native primitive/boxed/toJSON semantics, date/typed-array/error behavior, cycles/failures and deep stack safety. Getter/toJSON calls follow one traversal's occurrences, never repeat for retry/page/fact capture. Strict new DTO validation remains accessor-free and separate. Unsupported/unrepresentable output records truthful unavailable retention, not empty-success substitution.
2. **Normal and synthetic finalization:** both actual batch and Code Mode call the injected retention owner. The original source captures an envelope, not the raw huge value. F1 captures this bounded DTO without serializing the full payload again. Actual producer outcome determines isError/projection; payload error/code heuristics retire for new results. Preserve legacy historical interpretation.
3. **MCP:** preserve content, structuredContent and isError in the full normalized payload before the current bridge loses them. Existing supported image blocks keep order and exact input contract. Unsupported audio/resources remain descriptive references in preview plus full retained data; arbitrary structured keys are not removed by name. Never turn base64 binary fields into unbounded model text.
4. **Exec/background:** inject the host sink at `capture/output.ts` before OutputCollector/stream-consumer loss. Tee each actual ordered frame with backpressure and bounded queues. Capture failure does not manufacture a process failure or stop a running command unless existing execution policy requires it; record incomplete/unavailable retention separately. Preserve stream consumer stop/output limits and native settlement; no new background execution or unbounded waiting on a failed sink. Register final immutable frame/ref through the actual trusted exec result association, never by inspecting a spillPath or ref-shaped payload.
5. **Code Mode:** inner tool program value remains the actual once-lowered structured result; outer spill/cascade cannot replace it with preview. Existing4MiB/default transfer policy remains. Host-retained complete output survives a transfer refusal. Worker emission already truncated before host arrival is honestly source-limited; this gate does not claim arbitrary worker streaming. Host emission and later model/archive projection use the same envelope/ref owner and original code source receipt.
6. **Child/job/team:** new large result bodies are stored once at settlement. Records/outbox/notifications carry immutable result revision, bounded preview and ref, not repeated complete strings. Existing settlement/delivery owners determine completion; this gate cannot infer success from the last assistant fragment. Report generation/digests use stable revision metadata, not serializing full bodies; pages authorize through existing lineage then use bounded artifact reads. One task registry state/save chain remains after CX2 extraction. Same text in distinct revisions remains distinct. Current delivery semantics stay intact until R4C.
7. **Store and configuration:** replace shipping fail-open fallback (`return original`) for oversized output; a quota/retention refusal still gives bounded truthful output. Optional Context Mode's8MiB text capture becomes a preview/search policy, never the full-result limit. Preserve legacy API behavior via explicit facade/legacy branch without running both new and old full stores/cascades for the same result.
8. **Format/readers:** advance the actual session format9→10 from accepted E. Explicit literal9 and8 predecessor reads, header-only upgrades where applicable, owned reopen/append, current10/future11 refusal, metadata/body preservation and unresolved original execution state are mandatory. Update all version checks/derived projection/query/export consumers coherently, including the framed predecessor branch rather than only a numeric guard. New result refs are data dependencies, not source permissions/receipts imported into a child.

A running background process has a bounded live preview and an unfinished original capture, not a falsely complete immutable artifact. Final source settlement commits the full revision. An intermediate query does not copy/reseal all previously accumulated bytes; any retained intermediate page is explicitly source-limited to that page. Observing a running job cannot create a new process or final completion fact.

## Task 1: Connected retained-result ownership and shipping cutover

**Files:** the responsibility table above, their current public exports/package importer rows and actual callers. Tests go next to the corresponding owners; large fixtures/scripts remain test-only. Root does not write implementation code.

**Consumes:** current F1 required settlement source/capture/admit/reconcile; F2 conversation projection and legacy parsing; C3 protected rewrite source and current binding; F4 source/generation/Stop boundary; accepted E final request assessor. Existing workspace ContextOutputService, exec streaming owner, private prepared call and current task/result ownership.

**Produces:** the closed ResultEnvelope/ManagedArtifactRef contracts above; actual bounded model/archive result projection; durable range-readable artifacts under existing quota/pins; original-operation finalization/recovery; revision-based child/job report bodies. No new model allowance, semantic fork authority, wake scheduler or claim ledger.

- [ ] **Step1 — Freeze actual integration notes before product edits.** Inspect named owners at the accepted E BASE. Record exact event discriminants, version upgrade paths, finalization/capture handles, artifact operations and which producer owns each outcome. Check package graph and actual public readers. Resolve any mismatch with the fixed contract before introducing code. Write real source→envelope→receipt→reader mappings; a detached unused store is not completion.
- [ ] **Step2 — Add discriminating RED controls at actual current boundaries.** Add `context-output/test/managed-artifacts.test.ts`, `core-tools/test/result-finalization.test.ts`, `compaction/test/retained-result-context.test.ts` and owner-specific integration controls as required. Capture current large-output/fail-open/MCP/guest-value loss without weakening assertions. Use literal sizes and independent expected bytes/digests; no production estimator as expected oracle.

```ts
const originalBytes = 104_857_600;
const ordinaryCap = 64_000;
// Fixture generator and expected digest are independently produced from fixed bytes.
expect(observedBodyCalls).toBe(1);
expect(Buffer.byteLength(JSON.stringify(actualModelResult))).toBeLessThanOrEqual(ordinaryCap);
expect(coldStreamedBytes).toBe(originalBytes);
expect(coldStreamedDigest).toBe(independentOriginalDigest);
expect(actualOutcome).toBe('succeeded');
expect(replayedBodyCalls + repeatedFinalizers).toBe(0);
```

The example's originalBytes oracle applies to a literal text/raw-frame source; a JSON-encoded object independently includes its syntax bytes. Do not compare incompatible scopes.

- [ ] **Step3 — Implement closed contract, shared serializer and legacy/version path.** Use the responsibility leaves above. Add direct codec tests for deep plain data, numeric/source key order, sparse arrays, strings/quotes/emoji/NUL/unpaired surrogates, getter/toJSON occurrence counts, cycles and source mutation after capture. Assert old native JSON behavior on separate fresh fixture instances; do not invoke the same getter fixture twice to generate expected data. New strict envelope capture must invoke no getters. Test predecessor/current/future versions and malformed envelope alternatives through actual codecs/owned append.
- [ ] **Step4 — Implement artifact writer/index/reader/ownership as one real owner.** Test exact byte vectors for empty/one/two/nonpoweroftwo chunks using independently authored SHA input blocks; checked partial writes, short reads, corrupt/swapped leaf, truncated/header/root mismatch, stale revision, safe-integer overflow and invalid UTF-8 offsets. Inject failures at body/index sync, manifest/pin publication and uncertain completion. Assert same operation identity on recovery and no ref before artifact commit. Default512MiB accepts a100MiB result including actual index/staging overhead; deliberately small quota reports unavailable and preserves all older pinned objects.
- [ ] **Step5 — Connect normal/synthetic/MCP and original finalization recovery.** Actual tool batch and Code Mode use the same bound port. Hold artifact/fact completion, Stop, revoke/change binding, fail a hook and resume storage. Assert body/getter/toJSON/finalize/post-tool occurrence counts and truthful outcome; inspect committed sequence ordering and cold replay. A changed model-authored object cannot forge a trusted outcome/ref/producer stream. Fix cached rejected-Promise recovery through the original handle, not by clearing state and re-executing the phase.
- [ ] **Step6 — Connect actual exec frames and Code Mode program values.** Exercise real controlled transport with alternating stdout/stderr frames totaling100MiB beyond the old collector cap. Independent raw-byte oracle verifies complete frame stream after cold open; model/collector preview remains bounded. Verify insufficient quota, canceled/abandoned output, background promotion, later job query, host shutdown and stream consumer cap without deadlocks or altered process authority. Exercise actual shipping cascade mount order and nested program access to fields beyond preview; above guest transfer cap must explicitly refuse transfer while retaining the host artifact.
- [ ] **Step7 — Connect revisioned child/job bodies and bounded reports.** Generate at least100actual owned result revisions with1MiB text each under sufficient quota. Their result/outbox/report metadata contain only bounded previews/refs/revision facts; full bodies are not duplicated. Report digest/cursors remain stable across unchanged reads, reject changed revision, and return pages under16,384final JSON bytes. Same-text different revisions remain distinct. Cross-owner/workspace/revoked-source/ref-shaped/path-forged reads perform zero body I/O. Retrieval alone cannot start an Agent, model, tool or wake.
- [ ] **Step8 — Close lifecycle/readers and remove conflicting shipping paths.** Actual clear/deletion/archive/TTL/quota/index-loss/cold/concurrent-store scenarios verify pins and owner isolation. Inspect the real production graph: no full-result double store, unbounded spill fallback, name-based removal of arbitrary payload fields, full-body report hashing, raw log as child seed, or guest preview substitution. Old source limitations remain visible. Record before→after file responsibilities and full S25/CX2 coverage without claiming unrelated original decomposition progress.
- [ ] **Step9 — Run affected owner and consumer gates, then actual packaged flows.** Sequential direct installed test runner, maxWorkers2/minWorkers1; CLI serialization tests single worker. Run core-session, persistence/JSONL, core-tools, context-output, output-retention, MCP bridge, exec, Code Mode, subagent/report/Team, connected agent/reduction/executor and query readers appropriate to changed paths. Run affected types, normal reachability/acyclic graph. Preserve baseline/setup/failing receipts and source timing; don't invent passing totals or hide old failures. Retest untouched broad areas only for a new concern. Build fresh isolated Gateway/CLI copies and exercise real finalization/read/Stop/continuation/predecessor paths through copied modules and actual bundled entry points. Record source→copy maps, transformed test imports, build input manifests and immutable before/after file hashes.
- [ ] **Step10 — Deliver one connected task for independent review.** Commit coherent product changes on the existing branch, exclude root docs. Report all acceptance IDs below, exact source-time qualifications, data/migration compatibility, incomplete sources and unexecuted paths. Supply explicit immutable evidence set and separate copy/source manifests; preserve all failed attempts. Root independently checks identities, sends the whole range to one fresh GPT6.1Sol reviewer and handles scoped corrections/acceptance. R4B/C and R5/R6 do not start from an unaccepted R4A result.

Use these actual installed commands, with the stated working directory and source/evidence capture around each execution. The red result must be an asserted behavioral failure, not a missing import or no-tests setup failure.

```powershell
# cwd D:/I-harness-main/packages/context-output
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run test/managed-artifacts.test.ts --maxWorkers=2 --minWorkers=1
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/typescript/bin/tsc' --noEmit

# cwd D:/I-harness-main/packages/core-tools
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run test/result-finalization.test.ts --maxWorkers=2 --minWorkers=1

# cwd D:/I-harness-main/packages/compaction
& 'C:/Program Files/nodejs/node.exe' '../../node_modules/vitest/vitest.mjs' run test/retained-result-context.test.ts --maxWorkers=2 --minWorkers=1

# cwd D:/I-harness-main; fresh output roots only, verified to remain inside .tmp
& 'C:/Program Files/nodejs/node.exe' 'scripts/audit/check-reachability.mjs' --gate
& 'C:/Program Files/nodejs/node.exe' 'packages/desktop/scripts/build-gateway.mjs' --out '.tmp/context-r4a-gateway-a'
& 'C:/Program Files/nodejs/node.exe' 'scripts/build-dist.mjs' --out '.tmp/context-r4a-cli-a'
& 'C:/Program Files/nodejs/node.exe' 'scripts/verify-dist.mjs' --out '.tmp/context-r4a-cli-a'
```

The final report lists exact additional owner/consumer test filenames, commands, cwd and source hashes rather than treating this minimal command list as complete qualification. Reuse the established actual-artifact test-import transformation approach with new R4A-local scripts/maps; copied production modules remain unchanged. If a build/fixture command fails before exercising behavior, retain that receipt, repair only the setup and use a new result name.

## Acceptance matrix and limits

| ID | Independent expected behavior |
| --- | --- |
| A1 full-result scope | Literal1MiB/100MiB normal and exec sources; independently correct cold digest/length; bounded final model JSON; distinct encoded/original frame scope; no extra complete serialization in streaming path |
| A2 truthful no-fit | Insufficient quota/capture refusal never emits full original into prompt; execution succeeded/failed/unknown remains correct; unavailable/incomplete retention is explicit |
| A3 once-only recovery | Body/getter/toJSON/completed hook and guest counts unchanged after storage cuts/reconcile/Stop; original operation/source and fact receipt identities retained |
| A4 program/media | Actual Code Mode value survives normal preview; transfer limits unchanged; MCP structuredContent/isError and supported media order retained; arbitrary similarly named fields are data |
| A5 durable pins | Artifact/pin before ref fact; unknown stays protected; clear/TTL/quota refuse protected deletion; confirmed document deletion releases only its pin; archive/revocation does not delete |
| A6 bounded integrity |32KiB page over100MiB reads only verified touched chunks plus logarithmic proof/header/metadata; independent corruption/range/UTF-8 vectors fail; index loss cannot fake success |
| A7 fan-in |100distinct1MiB child/job revisions; no full body copies in metadata; final report≤16,384bytes, child preview≤2,048bytes, authorized advancing pages, no read-induced work |
| A8 compatibility | Literal previous/current/future formats, real owned upgrade/append and cold state; legacy incomplete data stays incomplete; new evidence doesn't grant imported execution authority |
| A9 actual consumers | Main/child/tool/Code Mode/CLI/SDK/Gateway model projection uses the envelope; discarded source bytes are never advertised complete; new and legacy paths do not double-run |
| A10 structure/evidence | Cohesive folders and one state owner; actual graph/types/tests/copies; original warning/failure evidence retained; no full redesign/release claim from this gate |

R4A does not resolve semantic fork/bootstrap, durable receiver claims/epoch/wake, historical provider failures, renderer Node/browser dependency, whole-session streaming/cold recovery, or complete release qualification. Those remain named R4B/C, R5 and R6 obligations; they are not exceptions to the actual result preservation guarantees above.
