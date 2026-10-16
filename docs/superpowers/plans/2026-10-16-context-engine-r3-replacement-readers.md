# ContextEngine R3 F2 — Replacement Readers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Root controls dispatch and fresh GPT6.1Sol review; no recursive agents.

**Status:** FUTURE DRAFT, gated on reviewed F1 and root executable rebase. D is the sole current product writer; F1 does not exist yet. Source findings are pinned **dc4a11f2513096bbe6cfc069231611bd4fc91a75** via `git show`, not concurrent product files. Planned fences are D5 → F1 managed journal6 → **F2 replacement readers7**; rebase actual reviewed format/API facts before dispatch. Older proposals using4/5 are superseded.

**Goal:** Read, strictly validate, project, snapshot, structurally export and dependency-completely seed committed positional replacement records through the real existing consumers.

**Architecture:** Extend the existing core-session conversation/history owner, F1 journal codec/managed owner and central seed remapper. A replacement occupies one archive event seq but inserts one derived summary at its covered span's logical position. F2 adds no selector, summary caller, publication port/producer, attempt policy, E assessor or second raw store.

**Tech Stack:** Existing TypeScript, pnpm/Vitest, F1 serialization/journal primitives; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-{redesign,framework,r1-contracts}.md`; `.tmp/context-redesign-20261015/{r1d-selection-contracts,r3-foundation-sequence,r3-sequence-root-rulings,r3-f1-root-rulings}.md`; reviewed predecessor `2026-10-16-context-engine-r3-managed-facts.md`. Current normative/root amendments supersede historical format/publication recommendations.

## Global Constraints

- One product writer; fresh GPT6.1Sol functional/structural review. Product0.1.13-rc.1 and original27/43 unchanged; prior whole qualification remains failed/incomplete.
- No installed profile, credential/account/provider/count, remote/release, dependency change or unrelated decomposition. No selector/publication producer is activated by accepting a reader schema.
- Core-session has no agent/provider/persistence reverse imports. Leaves normally150–400lines, functions<=120; facades150–250. Keep public-entry boundaries, tests and audit baselines; no fake consumer/export.
- Readers consume F1 immutable committed view or explicit read-only/unavailable observation. A complete unsynced frame observed on disk is not a live receipt. Unknown effect never authorizes replay.
- Preserve originals and legacy summaries honestly. No inferred positional coverage for old text, inherited human authority, copied calibration/receipt authority or second event array to implement rewrites.

## File and responsibility map

| Files under packages/ | Ownership/change |
|---|---|
| core-session `events/{types,replacement}.ts` | Version7 non-ignorable DTO and strict shape checks; union export only for actual reader/validator consumers. |
| core-session `conversation/{types,sources,exchange,validation,project,visibility,state}.ts`, new `conversation/replacement.ts` and cohesive `conversation/history/{state,advance}.ts` if needed | One staged history/prefix transition; stable item refs, exact coverage/dependency facts, positional transformation/tombstones. Project/render remain the only semantic pipeline. |
| core-session `projection/{messages,rewrite,search}.ts`, serialization/index; context-engine `snapshot/{build,revision,protected}.ts` | Real derive/prefix/capture/revision consumers, replacement epoch and truthful derived provenance. No reduction/selector modules. Existing reduction entry points need only the compatibility refusal below; no algorithm or producer is added. |
| persistence `format/{registry,validation}`, coordinator load/index/managed-document/writable-format, `seed.ts`, `fork.ts`; JSONL F1 codec/format-upgrade/session-io leaves | Version/refusal and shared history validation; committed source acquisition; sole seed compiler/remapping; unchanged journal ownership. |
| subagent `fork.ts`, child creation/readiness carriers; SDK server/session history; Gateway session readers/visibility/subagents | Readonly/committed consumer propagation, dependency checks before child create, strict event decoding where actually consumed. Thin carriers only. |

S2/S9/S17/S18 are existing structure regression gates. S20/CX1 and SDK/Gateway decomposition are not completed merely by these reader changes. No R4 semantic seed exporter or new delivery authority is introduced.

### Task 1: Activate strict positional replacement readers and dependent seeds

**Consumes:** reviewed F1 `SessionView`, one document/history owner, format6 journal codec, exact receipts and structural-export distinction; reviewed D native witness validation; R1C protection/capture and B2 attribution.

**Produces:** `ContextReplacementRecordV1`, source/item reference DTOs, internal replacement validation/transition/dependency functions, actual derive/snapshot/load/export/fork behavior. There is no new exported selector, standalone assessor or pending replacement state in Session.

- [ ] **Step1: Rebase and capture the real call graph.**

Record actual reviewed F1 BASE/interfaces and obsolete leaf destinations. At pin, `conversation/project.ts:13–16` validates the entire archive then folds; visibility precomputes all shadows/cuts (`visibility.ts:7–19`). Extending validation by calling projectConversation would recurse and later results/rewinds could incorrectly bless an earlier manifest. Existing seed remap filters context facts/converts accepted-v2 and finally validates as literal3 (`seed.ts:88–140`); update target format deliberately. Actual fork paths are persistence `fork.ts:33,51–151` and subagent `fork.ts:38–45`, not another compiler. Reuse predecessor receipts; baseline only affected behavior lacking applicable evidence.

- [ ] **Step2: Freeze the exact schema and addressing contract.**

```ts
interface ConversationAddress { readonly seq:number; readonly part:string }
interface ConversationItemRef {
  readonly kind:'input'|'exchange'|'summary';
  readonly at:ConversationAddress;
}
interface ConversationCoverage {
  readonly item:ConversationItemRef;
  readonly sources:readonly ConversationAddress[];
}
interface ContextReplacementRecordV1 {
  readonly type:'compaction/replacement'; readonly version:1;
  readonly replacementId:string;
  readonly coverage:readonly ConversationCoverage[];
  readonly insertBefore:ConversationItemRef;
  readonly text:string;
  readonly seq?:number;
}
```

Require explicit version1, no ignorable:true, no extra candidate/binding/receipt/authority fields. replacementId is nonempty ASCII<=256bytes, unique within the document; text is a nonempty/non-whitespace string retained exactly. This is not a token/readiness limit or certification of summary truth. Numeric seqs are safe nonnegative integers, strictly earlier than replacement.seq. Parts are nonempty strings<=64UTF-8 bytes and must exactly match actual projector-produced parts; syntax alone never validates them. Empty arrays, duplicate item refs, duplicate addresses within an item's sources, forward/unsafe/nonunique addresses or unknown item kinds reject.

ConversationItem gains optional readonly `ref`; it is absent if establishment/full coverage is unsafe. Record establishment directly in its builder at creation—never parse ephemeral item.id or assume the first sources entry is establishment (exchange sources may start with step). `coverage.sources` equals the exact addressable union of item.sources and provenance.evidence, ordered by seq then UTF-8 part bytes. This includes admission/image/native companions where present. Shared structural sources across different items are allowed only for a complete shared unit.

An active replacement-summary has establishment `{seq:replacement.seq,part:'message'}`, its own replacement source and derived-summary provenance; original sources are lineage/dependency evidence, not new user authority. A nested replacement covers that summary's own source, then recursively depends on its original manifest. Expose the summary manifest as readonly derived metadata reused from its owned event; include replacementId/coverage/insertion in actual snapshot semantic identity, not only summary text and its own seq. Do not expand its emitted text sources into resurrected original items.

Use scalar-safe `SESSION_CONTEXT_REPLACEMENT_FORMAT` with closed reasons: shape, format, unsafe-address, duplicate-id, missing-source, coverage-mismatch, noncontiguous, incomplete-unit, protected-source. Include reason and safe seq only; never text/native/tool bodies. Persistence wraps through its existing unsupported-format error boundary.

- [ ] **Step3: Write literal RED controls before implementation.**

Create core-session `test/replacement.test.ts` and persistence `test/replacement-seed.test.ts`; extend existing suites below. Fixtures construct explicit format7 decoded histories/frames, not a fake production publisher. One legal closed legacy fixture fixes raw seq/part refs: `turn/start0,H1=user/message`; E1=`step/start2,assistant/message3,step/end4`; E2=`step/start5,assistant/message6,step/end7`; tail=`step/start8,assistant/message9,step/end10`; R11 covers establishment3/message and6/message with full sources `[2/step,3/message]` and `[5/step,6/message]`, inserting at3/message. Assert literal order `[H1,S11,E9]`, never `[H1,E9,S11]`. These are older closed exchanges within an open local turn, while H remains protected. Add accepted-v2/native/parallel/image fixtures with literal complete coordinates.

```ts
it('inserts at coverage position and preserves a prefix', () => {
  const session = decodeLiteralReplacementFixture();
  expect(renderLabels(deriveMessages(session))).toEqual(['H','S11','tail']);
  expect(renderLabels(deriveMessagesUpTo(session,10)))
    .toEqual(['H','E1','E2','tail']);
});
```

Local fixture helpers live in the test file; expected coordinates/order are handwritten. Run each new file with `pnpm exec vitest run test/<name>.test.ts --maxWorkers=2 --minWorkers=1` in its actual package. RED must expose missing replacement semantics/validation, not an unrelated malformed native payload.

- [ ] **Step4: Factor one prefix history transition, then implement replacement validation/fold.**

Separate equivalent extraction and behavior commits where equivalence holds; preserve existing six-route/legacy rendering first. Extend the **existing** ConversationValidationIndex with staged logical-item/reference/dependency metadata. Extract shared prefix transitions into cohesive history/replacement leaves; projectConversation consumes the same resulting logical state and existing payload renderer. Neither validation nor those leaves import projectConversation. Stage checks ordinary acceptance plus replacement metadata before commit; journal/hydration/projection all use that same owner. No filtered Session reconstruction, second event-to-message fold, raw history cache or rendering arbitrary payloads during structural validation.

Advance archive facts in order. At R's historical prefix, materialize/finalize only known units; require coverage to equal one nonempty contiguous active item span, exactly in order, with insertBefore deeply equal to coverage[0].item. Full sources must match; no dropping an image/sidecar, accepted call/result/dispatch or another member of the same physical step. Units must be closed/addressable, accepted or honest legacy-inferred; failed/unaccepted fragments and pending/unknown effects reject. Sharing a physical step across an unselected input blocks that span. A later result/end cannot retroactively close a unit for an earlier R.

Consume the same core-session archival protection facts as R1C: current local input/image/steers, session-scope instructions, pending admissions/promotions and unresolved groups/delegations remain protected. Prefix validation must not consult later events, live task maps, providers or a new policy owner. F2 establishes historical structural validity, not F3's live binding/source/protection CAS or target assessment.

Remove named active items and insert one summary at their first logical position. Keep consumed-source/item tombstones separately from emitted summary visibility in the same derived state. Nested R12 covering S11 and tail must leave only S12 plus H, retaining dependencies on R11 and E1/E2/tail. A record naming previously consumed E1 directly is stale/missing-source and rejects. Duplicate replacementId rejects even if rewound/hidden.

Apply rewinds in archive order; tombstones are monotone. Rewind may hide R's emitted summary according to R's **archive seq**, never its logical insertion position, but does not unconsume its originals. Later legacy summary/reset naming R.seq hides that summary without source resurrection. Validate every R at its own prefix even if later hidden. throughSeq ignores R until its own seq is included; preserve the existing content-addressed prune exception without letting future prune/shadow/rewind facts validate coverage historically. No new chronology for legacy compaction/summary: preserve its existing append-position/shadow semantics.

- [ ] **Step5: Wire real snapshots, codecs and version7 refusal.**

Register the non-ignorable event and shape/history validator in actual core-session append/full/incremental/import paths and persistence registry/preflight/load/loadOwned/snapshot. Ordinary F1 producer-port unions still exclude replacement; no publication constructor/entry point is added. Add only a fail-closed reader-compatibility gate at existing legacy compaction/reset entry points: replacement-bearing histories cannot enter their old raw-event selection/rewrite path before F3. Return an explicit safe unsupported disposition before summary calls or marker writes; do not report compacted:true or add an append-position fallback. Normal reads and separately admitted ordinary continuation remain available. At pin, compaction/projection/shadowed.ts has its own raw shadow fold and projection/window.ts:50 publishes raw resets, so merely teaching deriveMessages about R would leave an unsafe consumer. This guard is not a new reducer/publication producer. Existing real readers consume histories containing it through deriveMessages/deriveMessagesUpTo, context-engine capture, SDK session/events and Gateway source/session views. Raw history readers expose the record as history; they do not flatten it into a model message or compute fit.

Include replacement in existing rewrite/context-epoch derivation (`conversation/state.ts:30`, `projection/rewrite.ts`) and semantic source identity. Budget/usage/diagnostic appends still do not cause semantic/epoch changes; pure reads never prepare/auth/send. Preserve protection and historical measurement semantics; replacement sources remain summary/derived, inherited summaries observation/derived rather than human requests.

Header7 gates replacement on **every** decoder before repair/write, with exact format passed to full/staged validation. Read1–6 unchanged, including D witness/B2 facts; old runtime6 refuses7. Owned6→7 header upgrade preserves journal metadata and raw frame/body bytes; hashes exclude the header per F1. Unsupported upgrade refuses. One-time physical stream-copy+rename is allowed by F1, never a per-append history rewrite.

Distinguish three actual operations: same-file byte-copy export preserves original F1 frames/metadata; `toJSONL(SessionView)` produces a fresh coherent structural framed representation using F1 codec, with fresh framing identity and no transplanted source offsets/durability receipt; fork compiles remapped events into a **new** owned child journal. `fromJSONL` validates structural framing/record history, not live storage durability. Imported/child journal receipts are obtained only from their actual F1 owner. No parent receipt/send/calibration becomes child execution evidence; active unknown source read remains unavailable, never bypassed by structural export.

- [ ] **Step6: Extend the existing dependency-complete seed compiler.**

Implement replacement dependency calculation inside the existing history/seed path, not another renderer or stored manifest. For each retained R recursively require its covered item establishments/full sources; nested R records; owning accepted/legacy step lifecycle including closure; acceptance/call/dispatch/result/native/image bundle; matched admission/promotion and required semantics fence; prior rewrite/rewind evidence necessary to validate R historically and preserve its emitted visibility. Dependency facts are derived seq sets/edges over the original archive, not copied payloads or new persisted authority. Strictly earlier refs guarantee acyclic traversal. Unknown/ambiguous dependency or absent address rejects `SessionForkUnavailableError` before child creation.

`remapConversationSeed` receives actual sourceFormat and retained event identities. Resolve the complete dependency closure **before** any dropping/renumbering; never flatMap missing coverage entries or use remapSeedEvent's permissive legacy path for R. For a replacement-bearing completed prefix, retain original proof records and relevant rewind markers within the chosen prefix instead of the current drop-rewound-body optimization (`fork.ts:128–151`); originals remain hidden by rewrites/cuts. This deliberately may retain more raw history. For last-N-turn child tails, do not silently fetch dependencies outside that selected tail: reject partial sources. No extension beyond the requested boundary; if preserving the selected source view requires an outside-boundary marker, reject rather than resurrect it. Nonreplacement histories retain existing behavior.

After final fence placement and operational-context removal, allocate child seq map once. Remap every coverage item.at/sources/insertBefore coordinate exactly; namespace replacementId with the existing deterministic seed namespace helper. Remap acceptance/action/attempt/rewind/image/input references using the central compiler; keep B2 accepted-v2→structural-v1 inheritance and D witness handling. Recompute seedLength, validate at target7 and compare ordered child active items/visibility with the selected parent view. Never treat a replaced summary as a raw tool output or force it to append position. A complete prefix succeeds; a partial missing-original/nested-manifest/closure/image/fence proof rejects before coordinator.create. No seed receipt authority is copied.

- [ ] **Step7: Run independent nested/rewind/format/consumer controls.**

Literal expectations: `[H,E1,E2,steer,E3,E4,tail]` with R covering only E1/E2 gives `[H,S,steer,E3,E4,tail]`; coverage E1/E3 across steer rejects. R12 covering S11+tail gives `[H,S12]`. Reset/rewind hiding S12 leaves H and any genuinely retained later suffix, **never** E1/E2/tail. Future results/end/rewinds do not turn invalid earlier R into valid history. Duplicate IDs/coordinates, altered full-source order, partial shared-step/parallel/image/native bundle, current human/session input and pending/unknown outcomes reject through live stage and cold/import paths alike.

Use a literal child fixture removing only operational audit event0: parent `turn/start1,H2,step/start3,assistant4,step/end5,turn/end6,R7` maps1→0 through7→6. R7 establishment4/message becomes3/message, sources3/step+4/message become2/step+3/message, and R7 becomes child seq6 with a namespaced ID. Assert insertion and nested IDs exactly; missing one source rejects before create count changes. Include no-rewind shortcut, rewind-filtered complete prefix, N-turn partial tail, accepted-v2 inheritance, original source untouched and continued child append under its own receipt. Live committed→structural export→cold projection matches literal order; byte-copy export remains byte-exact, structural export is valid without pretending frame/receipt equality. Test torn F1 batch containing R never activates its first embedded event, wrong format rejects before mutation and old runtime6 really refuses7.

- [ ] **Step8: Complete scoped gates, structure review and evidence report.**

Run sequentially maxWorkers2/minWorkers1 using actual package-directory `pnpm exec vitest run ...`: core-session full (including existing `conversation-projection,conversation-state,compacted-step,projection-rewrite,rewind-event,request-context,session,accepted-attribution`); persistence full (`conversation-format,load-gate-coverage,seed-semantics,fork,rewind-event,ownership`); JSONL full; context-engine `test/snapshot.test.ts`; subagent `test/fork-isolation.test.ts` plus actual reviewed resume/child controls; SDK `test/session-context.test.ts`; affected Gateway session-management/visibility/subagent/cold readers and F1 packaged fake-transport smoke. Verify filenames against reviewed F1 before commands. Reuse six-route independent corpus for rendered grouping/sidecars and prior F1 crash/receipt tests; no live-provider claims.

Typecheck changed packages/all actual consumers, run `pnpm exec tsc --noEmit -p e2e/tsconfig.json` and `pnpm verify:reachability` without reseed. Fresh isolated copied Gateway/CLI smoke reads/imports/forks literal7 history with zero model/tool calls, verifies6 refusal and child receipt identity; reuse F1's verified package build commands with fresh output directories/source-copy hashes. Fresh full-range GPT6.1Sol functional+structural review precedes progression. Report BASE/HEAD, exact version/DTO/consumer map, prior semantics preserved/intended differences, rejected partial forks, retained dependency cost, test receipts and unresolved qualification. This completes reader substrate only, never R1D selection/F3 publication or more decomposition counts.

**Root rulings2026-10-16:** retain in-boundary rewind/proof history for replacement-bearing complete-prefix seeds; reject a fork whose requested boundary cannot carry the proof. This intentionally costs additional raw history until R4's semantic seed work, and never extends the requested tail or copies parent authority. Ratify the narrow reader-compatibility refusal of old reduction/reset on replacement-bearing histories until F3; assert zero summary calls/marker writes and continued ordinary read/append support. These are transitional safety boundaries, not final loss of compaction support or completed F3 work.

**Remaining executable preflight:** confirm reviewed D/F1 versions and concrete owner/codec APIs, actual shared prefix/protection interface and exact consumer commands before dispatch. No new reader size/token policy or user approval is introduced. F3 retains the live producer, publication CAS/issuance, summary quality and exact final-request readiness gate.
