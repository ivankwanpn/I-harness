# Compact passive Code Mode repair implementation plan

> **For agentic workers:** after root promotion/dispatch, use the executing-plans skill inline, stage by stage. One sequential core→B2→Code Mode owner; no parallel writers/subagents are authorized by this packet. Steps use checkboxes for execution tracking, not claims of completed work.

**Goal:** preserve committed passive JSON through real selected semantic forks/nesting/rewind without copying runtime authority or adding provider-message bytes.
**Architecture:** use the spec's anonymous eligibility tape, interned exact valueJson and scalar cut aliases. Keep raw legacy replay's existing seq-optional semantics separately; enter tape capture only through actual held completed-selection context. Existing B2 owns original publication/recovery and existing Code Mode restore owns consumption.
**Tech Stack:** existing TypeScript ESM, Node>=22.18, installed Vitest3/TypeScript entrypoints; no new runtime dependency or package-manager execution.
**Spec:** `docs/superpowers/specs/2026-10-27-passive-code-store.md`, including PC06; read the compact independent review and promoted public-fork spec too.

## Global constraints and execution gates

- Root promotion2026-10-27 authorizes only the writer and staged file reservations recorded in this plan ledger. Initial CURRENT BASE is the promotion commit descending from accepted MAIN9b756167. Checkpoint stages0–2 may proceed; stage3 bootstrap/controller and stage6 full-host integration wait for their separately accepted fixed handoffs. Preserve all original packets and raw regressions.
- Product stays0.1.13-rc.1; keep Session13/journal1/stage1 and unpublished semantic-seed-v2/DTO2/passive1 only. V1/empty hashes/bytes, old birth frames/stage, seedLength=groupCount+1, two phases and once-only original capture stay exact.
- Keep maxStoreBytes default1,048,576 and configurable floor/clamp1..4,194,304; header<=65,536, stage<=262,144. No aggregate arbitrary cap, source history fallback, fake readiness, partial state, new registry/grant or JSON provider stuffing.
- F1 HOST owns `coordinator/bootstrap.ts`/`managed-document.ts` cache-READY repair now. Do not edit either during independent preparation. After its accepted handoff/rebase reserve ONLY `bootstrap.ts:checkBirth` reconstruction; `managed-document.ts` stays excluded. Preserve F1's resulting READY checks and original ownership/cache semantics.
- PC06 keeps standalone conservative. Whole original store positive must use the REAL reviewed shipping full host/controller; separately assert nested standalone typed refusal. Do not infer absent inherited L1 sidecars from empty managed artifacts or create a fake host/retentionless proof.
- ROOT INCIDENT RULE: no pnpm run/exec/test/type shortcuts, autorelink, install, dependency repair or package-manager subprocess. Invoke the existing RESOLVED Node+Vitest/TS files directly, one package-CWD command at a time, maxWorkers2/minWorkers1; record resolved paths/hashes/CWD/env/exit. Setup/import failure is not an intended RED and authorizes no relinking. No broad reruns without evidence.
- Read-only resolution example for existing MAIN dependency runtime (future dispatch may supply equivalent verified absolute paths); these are variables for direct executables, not command wrappers:
```powershell
$pcNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$pcVitest = Join-Path (Get-Item 'D:/I-harness-main/node_modules/vitest').ResolveLinkTarget($true).FullName 'vitest.mjs'
$pcTsc = Join-Path (Get-Item 'D:/I-harness-main/node_modules/typescript').ResolveLinkTarget($true).FullName 'bin/tsc'
```
- Before EACH single test/type invocation, create a NEW short fixture-owned root and SIX fresh subroots (including repeated same-suite runs); record them, never reuse ambient homes/evidence roots or change HOME/USERPROFILE. Run this setup again before the next command:
```powershell
$pcRunRoot = Join-Path 'D:/tmp' ('pc-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$pcIHNames = @('IH_CONFIG_DIR','IH_STRUCTURE_EVIDENCE_ROOT','IH_RESULT_INTEGRITY_EVIDENCE_ROOT','IH_LEGACY_FORK_EVIDENCE_ROOT','IH_MIXED_RETENTION_EVIDENCE_ROOT','IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT')
foreach ($pcIHName in $pcIHNames) {
  $pcIHRoot = Join-Path $pcRunRoot $pcIHName
  New-Item -ItemType Directory -Path $pcIHRoot -Force | Out-Null
  Set-Item -LiteralPath ('Env:' + $pcIHName) -Value $pcIHRoot
}
```
- Every test command below means direct `& $pcNode $pcVitest run ...`; every typecheck is explicit `& $pcNode $pcTsc --noEmit` from that package's CWD, after separate fresh-root setup. Never invoke a package script or runner shortcut to do either.

## File and interface ownership

| Slice | Files and responsibility |
| --- | --- |
| Pure store | New core thin facade `src/projection/passive-code-store.ts` and private `src/projection/passive-code-store/{types,legacy,replay,capture,prune}.ts`, plus `src/serialization/bounded-json.ts`; move/reuse current raw fold/strict encoder, compact interpreter/pruner and original-byte limits. |
| Selection/opacity | New core `src/conversation/passive-seed-context.ts`; existing seed-selection, history/group/turns, projection/rewind, events/conversation-source. Exact spec context, shared structural source, original windows and typed store-body opacity. |
| Codec | Core seed-types/capture/export/digest/codec, events/bootstrap/header, bootstrap-validation, managed/bootstrap/memory-bootstrap, internal/index exports. V1/V2 discrimination, complete seed reconstruction and closed faults. |
| B2 | Persistence semantic-seed.ts/coordinator/bootstrap-header.ts, capture reconstruction consumers; root-released bootstrap.ts:checkBirth only; audit JSONL format/backend fact-journal without changing layout/READY semantics. |
| Consumer | Code Mode state.ts/types.ts/runtime/limits.ts and existing restore adapter; persistence fork-controller.ts ONLY its first callback's held-owner export option after reviewed F1 rebase. No assembly/store-owner duplication. |
| Tests | New core passive-code-store.test.ts/passive-code-store-context.test.ts/passive-code-store-codec.test.ts; extend existing Code Mode store and semantic seed tests; new persistence passive-code-store-bootstrap.test.ts and JSONL semantic-codec2-predecessor.test.ts; existing executor code-mode-store.test.ts plus new code-mode-store-provider.test.ts. |

Task interfaces are exactly those in spec§2–3: HeldSeedOwner/CompletedPassiveContext/OwnedPassiveCandidates, createCompletedPassiveContext, projectPassiveCodeStore, capturePassiveCodeStore, replayPassiveCodeStore→StoreReplay, replayLegacyCodeStore→StoreEntries, semanticSeedFromRecords, and exportConversationSeed's optional internal passive option. Do not introduce a second draft naming set.

## Stage 0 — freeze real acquisition and predecessor evidence

- [ ] Read actual dispatched `managed-documents.ts:open`, `load.ts:loadOwned`, `managed/groups.ts:resolveFactGroup`, managed view construction and the reviewed full-host first capture. Record how a source becomes sealed and owner-bound; distinguish pure raw SessionView from actual acquired ManagedDocument.
- [ ] Before codec edits, freeze an UNMODIFIED format13/codec1 predecessor from root's supplied clean BASE as an isolated test graph. Add `session-persistence-jsonl/test/fixtures/semantic-codec1-predecessor13/{manifest.json,graph.json.gz,README.md,LICENSE}` and `test/helpers/semantic-codec1-predecessor13.ts`, following existing pinned capsule/hash/path validation and native-lock provisioning patterns. Record full commit SHA, every source/hash, package graph and native runtime receipt; no changed constants/source or current-workspace package resolution.
- [ ] Preserve original `session-executor/test/code-mode-store.test.ts` assertions and b16 raw failure. Do not run its nested standalone form as a supposedly supported final integration; reserve the later PC06 wiring migration and standalone-negative test separately.
- [ ] Capture no pass claim here; root reviews the manifest/source proof before the compatibility stage consumes it.

## Stage 1 — raw replay, strict encoder and compact tape

**Consumes:** existing state.ts predicate and runtime/limits.ts:json. **Produces:** shared exact raw fold, StoreReplay and passive interpreter/pruner. Add core tests first; Code Mode wrapper initially delegates raw replay without changing behavior.

- [ ] Add literal raw replay regressions for undefined seq and nonmonotone defined seq; neither uses append() to accidentally seal the fixture:
```ts
const s:Session={formatVersion:13,events:[
  {type:'code/cell',cellId:'c',sessionId:'o',state:'completed'},
  {type:'code/store',version:1,cellId:'c',sessionId:'o',writes:[['x',7]]},
]};
expect(replayLegacyCodeStore(s,'o')).toEqual([['x',7]]);
s.events[0]!.seq=10;s.events[1]!.seq=5;
expect(replayLegacyCodeStore(s,'o')).toEqual([['x',7]]);
```
- [ ] Add tape regression with unit0 x=1, unit1 y=2, true(unit1), true(unit0), cuts at3/4: cut0 must be y2; cut1 must be x1,y2 in WRITE order. Add same-unit put x1,true,put y2: only x1; put x7,true,cut,false: earlier7/latest empty. Record intended RED, then implement the minimum shared fold/interpreter.
- [ ] Factor the EXISTING bounded encoder/constants into core and reuse it in runtime/limits.ts without changing any other runtime limits. For valueJson verify property order, nested arrays, __proto__/origin literal data, exact re-encode, duplicate-key/whitespace/escape/NaN refusal and original decoded entry-array bytes.
- [ ] Add pruning fixtures: huge old x then y then small x retains x-before-y order with touch but drops obsolete huge body; true,new put,true must keep the needed latter transition; unused keys/values/units/cuts disappear. For each retained nonfault cut compare pruned vs unpruned shared evaluator entries EXACTLY; no K*G map serialization.
- [ ] Add equal-end different-fault fixture and explicit result assertions:
```ts
const fault:PassiveCodeStoreV1={version:1,units:0,keys:[],values:[],rows:[],
  cuts:[{end:0,overLimit:true},{end:0}],latest:1,completed:[],groups:[0]};
expect(replayPassiveCodeStore(fault,0)).toEqual({kind:'limit-exceeded'});
expect(replayPassiveCodeStore(fault,1)).toEqual({kind:'value',entries:[]});
expect(Math.min(fault.groups[0]!,fault.latest)).toBe(0);
```
- [ ] Run core CWD `& $pcNode $pcVitest run test/passive-code-store.test.ts --maxWorkers=2 --minWorkers=1`, then Code Mode CWD `& $pcNode $pcVitest run test/store.test.ts --maxWorkers=2 --minWorkers=1`, with fresh six-root setup before EACH. Require raw legacy positives/limits unchanged; preserve evidence.

## Stage 2 — exact completed context and source opacity

**Consumes:** spec§2 source coordinates/owner types and Stage1 evaluator. **Produces:** completed-only optional export capture with descriptor-safe deferred candidates; all/last-turns/none remain existing behavior.

- [ ] Write context cases first: local requested end plus trailing commits, next start exclusion, explicit inherited one-turn group excluding fresh tail, inherited-default including fresh unframed tail, beyond-archive latest, in-range unfinished refusal, manifest/spanning/unframed ambiguity, wholly unframed raw no-boundary refusal, completed framing with zero groups.
- [ ] Implement one internal SelectionSource builder using existing index/projectHistory/historyTurns metadata; selected original/rebased ordinals, groups' actual establishments and exact Upper union must match spec. Reuse it inside selectSeedHistory and context factory; no second host walker. Add held-owner mismatch/stale/seq-admission failures, tested separately from valid raw replay.
- [ ] Write opacity REDs before changing `events/conversation-source.ts`: superseded cyclic/NaN/nested-getter body must not be traversed; selected same bodies refuse with getter call count0; value-SLOT accessor refuses with call count0; malformed eligible key/pair/version refuses even when overwritten; foreign/ineligible malformed entries gain no new shape failure. Keep non-CodeStore metadata source validation and full durable intake unchanged.
- [ ] Add the narrow typed code/store source branch; qualify record eligibility/ownership at ALL A before checking entries; own scalar/pair/key/value-slot descriptors before deferred body slots. Capture only final selected bodies with captureSelectedData discipline. Raw unit tests may use literal source/candidates; do not claim such fixtures prove public held admission.
- [ ] Factor original-window collection in projection/rewind.ts while retaining old rewindCuts output; translate original aliases8/3 windows BEFORE union, then test post-marker branch commits survive. Assert map min uses ordered cut IDs, handles equal ends, and composes nested group aliases/current branch.
- [ ] Close the nested candidate roundtrip before advancing: inherited touch(x),put(y,2),put(x,1),true must remain x,y after project→capture→project→capture without obsolete x bytes. Inherited cut0={end:0,overLimit:true}, cut1={end:0}, latest1/groups[0] must roundtrip fault/ordinary-empty distinctly and remain V2. CandidateRow must retain touch; deferred slots distinguish inherited exact valueJson from local raw descriptor values; private old→candidate→rebased maps carry effective inherited observations, not end-only aliases.
- [ ] New candidate cuts begin unclassified, not empty. Classify min-selected inherited cuts from their exact observation; ordinary-base local tails use complete replay+fresh original-byte encoding. For a fault effective base plus no qualifying local puts, retain the exact fault; later ordinary bases are independent. Add the hidden {x:huge,y:1}/{z:huge,y:1} then x=0 counterexample: identical pruned faults cannot classify those hypothetical new outcomes. Test actual runtime admission AND commit reject writes against a fault baseline; forged unclassifiable capture refuses invalid-seed rather than inventing empty/fault/partial data. Raw legacy semantics stay unchanged.
- [ ] Verify omission: earlier7/latest empty→V2; latest empty but rewind nonempty or fault→V2; all A ordinary empty/no fault→undefined/V1. Do not use latest-only emptiness or a synthesized completed turn.
- [ ] Run core CWD `& $pcNode $pcVitest run test/passive-code-store-context.test.ts test/semantic-seed-boundaries.test.ts test/semantic-seed-turns.test.ts test/semantic-seed-replacement.test.ts test/semantic-seed-payload.test.ts --maxWorkers=2 --minWorkers=1`; then fresh setup and core CWD `& $pcNode $pcTsc --noEmit`. Require no getter execution and no B1 changes except named unfinished fallback.

## Stage 3 — closed codec2 and complete B2 reconstruction

**Consumes:** owned compact DTO + exact context. **Produces:** digest-bound V2 seed/body and durable cold-readable original payload; V1 preserved. This stage MUST wait for root's accepted F1 READY-fix BASE and narrow bootstrap.ts reservation before editing that file.

- [ ] Add codec tests for every row/value wrapper/index/cut/flag field; finite parsed values, exact valueJson equality, dense units, groups count, unique completed ordinals, no dangling touches at nonfault cuts, retained-body validation despite any fault, unsupported version, payload/digest/cut tamper. Wire validation explicitly does not claim to re-prove discarded overflow bytes.
- [ ] Add V2 types/source+seed digest domains and manifest BODY payload; preserve all V1/empty constants and group schema1. Implement one `semanticSeedFromRecords(header,records)` dispatcher; test header/manifest mismatch and structural/prefix/full validation at incomplete/ready boundaries.
- [ ] Update ALL reconstruction literals: core bootstrap-validation source/prefix/full, memory bootstrap/internal exports, persistence compileSemanticSeed, bootstrap-header capture/build/stage parser. After explicit rebase change only bootstrap.ts:checkBirth's hardcoded V1 reconstruction to the shared dispatcher. No managed-document.ts edits, receipt/lifecycle/cache rewrite or new stage format.
- [ ] In real coordinator tests reserve/capture once, commit through original B2, close/reopen and inspect actual loaded V2 valueJson/aliases/digests; corrupt payload/codec must refuse before readiness. Compare unchanged header/stage byte limits and seed/completion frame keys/counts. Lost READY response and warm/passive retries must preserve original target/payload and never call capture twice.
- [ ] Add actual loadOwned acquisition tests: old missing seq is normalized by existing owner and resulting view is positional; defined nonpositional source is rejected by that same existing owner; every appended source fact is positional. A core source-label fixture cannot substitute for this proof.
- [ ] Run core CWD `& $pcNode $pcVitest run test/passive-code-store-codec.test.ts test/semantic-seed-codec.test.ts test/semantic-seed-origins.test.ts test/semantic-seed-omissions.test.ts --maxWorkers=2 --minWorkers=1`; persistence CWD `& $pcNode $pcVitest run test/passive-code-store-bootstrap.test.ts test/semantic-bootstrap.test.ts test/bootstrap-capture.test.ts --maxWorkers=2 --minWorkers=1`; separately each package CWD `& $pcNode $pcTsc --noEmit`. Fresh six-root setup EACH; preserve handed-off F1 READY/cache tests.

## Stage 4 — existing Code Mode restore and real B2 primitives

**Consumes:** validated loaded V2, existing target-local raw facts and actual Code Mode mount. **Produces:** complete bounded store restored through the ORIGINAL owner only.

- [ ] Write integration RED for a real B2 target with x7, existing registerCodeMode restore, local write8, disposal/cold restore and second same-owner actual B2 capture; source remains7 and global secret remains undefined. This is prerequisite-owner evidence, explicitly not final full-host public acceptance.
- [ ] Adapt existing restore port with the exact result branch:
```ts
if (result.kind==='limit-exceeded') throw new Error('Session store transfer limit exceeded');
return result.entries;
```
- [ ] Preserve legacy raw owner/seq predicate and target-local completed-cell rules. Apply inherited normalized alias/cut data plus actual local raw facts using the shared evaluator; no raw history fallback, ancestor lookup, worker clone or second store registry. Revalidate full decoded entries with target's actual configured bytes at admission/commit.
- [ ] Test default1MiB, configured smaller limit, valid up to4MiB and one-byte-over cases with Unicode/escaping; construct rewind that removes a size-reducing overwrite to prove capture-time absolute overflow, same exact restore error, later nonfault cut unaffected. No partial result from pruned fault payload.
- [ ] Run Code Mode CWD `& $pcNode $pcVitest run test/store.test.ts --maxWorkers=2 --minWorkers=1`, Stage3 real B2 direct command, then Code Mode CWD `& $pcNode $pcTsc --noEmit`, fresh six roots EACH. Record no source cell/invocation/tool/delivery/native eligibility, global secret or automatic model/tool action during fork.

## Stage 5 — genuine predecessor refusal and V1 birth compatibility

**Consumes:** Stage0 unmodified isolated codec1/format13 graph and new real V2 target. **Produces:** literal before-write refusal evidence, not a simulated version check.

- [ ] Add JSONL `semantic-codec2-predecessor.test.ts`; run the predecessor in a fresh process with import-resolution fencing (no current @i-harness package fallback), native-lock receipt and network/provider traps. Test predecessor coordinator load/loadOwned AND direct backend repair of ordinary and torn-tail V2 targets. Assert rejection before underlying repair/append/updateMeta/upgrade/replace writes and byte-identical target/header/stage/receipt files.
- [ ] Do not replace original source functions or constants. A wrapper counting attempted backend.repair is allowed; a supplied fake validator/reader is not. Direct-repair case may enter repair but must reject before any filesystem replacement/truncation. Preserve exact command/CWD/exit/stderr and source graph hashes.
- [ ] New reader must cold resume genuine V1 format11/12/13 birth+stage captures, compare raw birth headers/seed/completion keys/frames/digests byte-for-byte and retain existing format-upgrade rules. Never regenerate V1 with codec2, reconstruct from a made-up header, or call source capture during passive resume.
- [ ] Run JSONL CWD `& $pcNode $pcVitest run test/semantic-codec2-predecessor.test.ts test/format13-predecessor.test.ts test/bootstrap-physical.test.ts test/bootstrap-capture-physical.test.ts test/semantic-publication.test.ts --maxWorkers=2 --minWorkers=1`; include format11/12 predecessor controls, then JSONL CWD `& $pcNode $pcTsc --noEmit`, fresh six roots EACH. Verify zero writes despite torn tail; predecessor children use resolved absolute Node/loader entrypoints with no package-manager subprocess.

## Stage 6 — PC06 full shipping host positive and provider-byte proof

**Gate:** reviewed F1 full-host/controller handoff has landed on the root-selected BASE. Consume actual exported production constructor/options from executor `lifecycle/fork-handoff.ts` and actual CLI composition (or accepted Gateway equivalent); do not invent a test host interface to bypass its real retention/L1/observation owners. Fixture ownership is serial with F1.

- [ ] Change ONLY original executor code-mode-store fixture's fork wiring to actual issued full shipping host/controller, preserving every source7, child-read7/write8, grandchild8, source7 and secret-undefined assertion and cold service transition. Add source-cleared/unavailable cold grandchild and independent source mutation after capture controls. Do not replace the positive with host-required/refusal, raw import or B2-only substitute.
- [ ] Separately assert ordinary twoarg no-sidecar semantic baseline remains positive; seed-bearing nested convenience without issued full host retains the exact typed unsupported/host-required contract; artifacts/sidecars still require the genuine full host. Never add an empty-retention marker or widen requireRoot.
- [ ] In fork-controller's ORIGINAL B2 callback pass the spec's HeldSeedOwner option, bound to actual witness/document/core source ID/current guards. Verify no host walker, no source/target assembly during fork, no post-READY store installation and zero extra capture on warm/passive/lost-response retry.
- [ ] Add code-mode-store-provider.test.ts with real ModelClient stream request capture (existing code-mode.test.ts pattern). Run two cold actual assemblies with identical session ID/workspace/instructions/conversation/tool catalog: one valid V1 ordinary-empty baseline, one valid V2 carrying passive sentinel/large JSON. Deterministically capture identical prompt requests BEFORE explicit store query; compare exact bytes:
```ts
expect(Buffer.from(JSON.stringify(withPassive.messages)))
  .toEqual(Buffer.from(JSON.stringify(baseline.messages)));
expect(JSON.stringify(withPassive.messages)).not.toContain('PASSIVE-PRIVATE-SENTINEL');
```
- [ ] Through existing actual code_exec explicitly load/text the sentinel afterward; require the existing bounded tool output to contain it, while no-query provider messages remain unchanged. Include zero-group code-only seed and summary+typed-tail/no-consumed-body baseline; no generated message/text payload substitutes.
- [ ] Add long-session measurement with sparse retained cuts, repeated shared4MiB value and distinct required values: record R/E, C distinct ordered landmarks, L=1+completed.length+groups.length ALIAS SLOTS, Bk/Bv, final bytes/CPU. A thousand groups pointing to one cut still serialize a thousand slots; E is not proved linear in outcomes. Require O(Bk+Bv+R log(indexes)+E log U+C log(rows)+L log C), not K*G maps; obsolete bodies disappear. No timing-based pass or arbitrary cap.
- [ ] Run executor CWD `& $pcNode $pcVitest run test/code-mode-store.test.ts test/code-mode-store-provider.test.ts test/code-mode.test.ts test/code-mode-children.test.ts --maxWorkers=2 --minWorkers=1`; persistence CWD `& $pcNode $pcVitest run test/semantic-fork-baseline.test.ts test/fork.test.ts test/passive-code-store-bootstrap.test.ts --maxWorkers=2 --minWorkers=1`; run handed-off REAL F1 CLI/Gateway suites via the same resolved direct Node Vitest entrypoint. Separately run `& $pcNode $pcTsc --noEmit` in each affected package; fresh six roots EACH. No whole-feature GREEN until this passes.

## Final review/closure

- [ ] Compare the complete diff against spec B1–B5/PC06: no raw semantic change, exact context/opacity/fault/omission contracts, no provider bytes, no operational authority. Request independent review only after full authorized connected range is reviewable; preserve raw failures and stage/source manifests. Commits/merging/release remain governed by the later root dispatch, not this document.
- [ ] Report actual passing commands and limitations. No partial helper/core-only result closes the public durable positive. Re-run only affected failed/new changes; keep genuine predecessor and V1 birth evidence attached to the final source.

Remaining root decision is dispatch sequencing only: name accepted F1 READY-fix/full-host BASE, release narrow bootstrap.ts:checkBirth rebase plus original fixture/controller handoff, then assign a writer separately. All five reviewed semantics and PC06 have explicit candidate decisions; none is delegated to an implementer to guess.

## Root dispatch rulings

The inherited touch/valueJson/fault transport correction is accepted in design by passive-code-state-candidate-fix-review-20261027.md, preserving the earlier finding. This is one connected repair with staged evidence, not separate helper completion claims. Root reserves CURRENT for the pure/core/raw-wrapper stages while HOST completes F1. Stage3 narrow bootstrap.ts:checkBirth rebase requires accepted FC12 original-owner fix; managed-document.ts remains excluded. Stage6 original fixture/controller/full-host wiring requires reviewed F1 handoff. Ask root for concrete signature/owner mismatches, not the user. Do not invent an alternate host or weaken a positive test to pass a gated stage.

2026-10-27 staged release: after coherent Stage2 V1/context and pure inherited transport, the same CURRENT writer may continue Stage3 CORE types/codec/digest/reconstruction. The actual V2 manifest/window connection remains explicit pending work until then. Persistence bootstrap/controller and the original public fixture still require coherent F1 handoff. Scoped FC12 approval alone did not make its F1-dependent test fixture independent; an attempted partial MAIN integration was reverted with the exact setup/API failures retained. No temporary wire fields or fake host may bridge this dependency.
