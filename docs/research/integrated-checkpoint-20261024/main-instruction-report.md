# IC-B connected main instruction consumer — implementer report

Latest correction: **fix round1**, incremental BASE `829c369bd330ef41d1fea54b10bef18a022f7464` through `3e5c8c413b8d10280cac6eded3663ec3b80eb3c9`, is recorded at the end of this report for the same independent reviewer. Original implementation/evidence below are preserved; this correction is not yet independent-review acceptance.

Status: implementation and scoped qualification packet complete for fresh independent Sol review. This is not whole-version/release acceptance. Reachability still fails for the recorded legacy retirement/staged surfaces below.

## Identity and ownership

- Writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Branch: `codex/main-instruction-consumer-20261024`.
- Exact BASE: `754681367a230bd106382ab1fb4a381c333b4aa0`.
- Final local HEAD: `829c369bd330ef41d1fea54b10bef18a022f7464`.
- Full review range: `754681367a230bd106382ab1fb4a381c333b4aa0..829c369bd330ef41d1fea54b10bef18a022f7464` (all three connected stages and ICB-01 through ICB-06 refinements).
- Promoted binding plan: `D:/I-harness-main/docs/superpowers/plans/2026-10-24-main-instruction-consumer.md`, including root rulings. The checkout's original plan is not substituted for the root-promoted refinements.
- GPT-6.1 Sol only; no child agents were spawned. Root owns MAIN and independent review.
- Reserved `packages/session-executor/test/service.test.ts` was not edited, staged or run by this packet. Root separately qualified/integrated its P5 test-only correction (`48222ffe`, MAIN integration reported as `8f6a8ab0`); this branch does not mix it into BASE/WIP.
- Protected untracked Gateway diagnosis test was never edited, staged or executed. Final SHA-256 remains `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`.

## Resulting behavior and original owners

Main assembly now uses the observed instruction subsystem in `context/instructions/{contracts,host,policy,views,manager,targets,index}.ts`. It publishes the full existing runtime/context component through logical reconciliation after the once-per-step hooks/input claims. Instructions are an in-memory section getter; skills/subagent sections remain on that same full publisher. The old instruction pre-step renderer is no longer the main consumer.

The saved-profile factory requires the selected settings path. Its own SettingsStore uses B0's strict `loadObserved`, with a watcher baseline derived from that observation, synchronous W2 state fencing, joined serial reload jobs and native home `dirname(settingsPath)`. It does not overwrite the host's execution/provider store cache or use renderer drafts. Absent globalSources selects that native home's AGENTS/CLAUDE pair; explicit `[]` remains none. An unconfigured direct assembly/service embedder instead gets project-only enabled/max24000/globals[] defaults, with no ambient or legacy home lookup. Service shares its lazy owned default across Sessions; explicit environments are borrowed.

Desktop lends one real FsWatchService to trust/MCP watching, policy and one instruction observation owner. Actual run/headless, SDK and ACP thread the original resolved settings path; explicit-model headless options can choose the instruction environment/path independently of provider selection. Borrowers never close their parent. Close fences first, joins safe original work, preserves failed handles and only retires result-store authority after its real producer/runtime/manager/document prerequisites complete.

Private request evidence is a WeakMap membership token containing the originating exact view, authority/policy generations, immutable source dependency snapshot and captured selection generation. It is not an event/ack table, and its private revisions/tokens are not prompt text or journal/schema fields. Capture/current/budget reads use memory snapshots; admission performs actual reconcile and checks currentness after preparation/checkpoints and at synchronous transport guard.

Acceptance now returns the original `{acceptedSeq,outcome}` after its real flush/Stop gates and final usage/calibration handling. Response success no longer scans events by actionId. Pending confirmation receipts are consumed once by the actual issue callback, and final candidate/send/payload/semantic/action/attempt evidence must match. Confirm-only/local or mismatched issue is unqualified. The successful instruction notification runs after original finally/recovery.close and final Stop. It consumes only its captured P generation, including legitimate completion whose source became stale after issue; it cannot mark that source currently ready or consume later reads.

Original acceptance, unstarted-call, real registered batch and reduction sources own their pins. Batch registration synchronously moves the already held continuation lease without a refcount gap. Drains join original results/records before releasing; failed release retains the same original handle. IA's only change is resetting a failed close attempt promise so that the captured original lease can retry, while the closed fence and recorded irrecoverable file-cleanup failures remain intact.

ICB-04 put runtime publication leases on the original RuntimeContext publication record, beside its actual capture/action/outcome and finish-once/cleanup state. `render` retains only on actual new capture, not dedupe or failed previous reconciliation. `settleOriginals` captures finite entry records/flights, joins only those accepted operations, then reconciles/releases those originals without getters, source discovery, factories, new actions or new text publication. Internal render reconciliation does not join its own flight. Known optional absence is terminal management failure, not rendered-ready success. The narrow assembly prerequisite calls this exact owner before existing S2 settleFinishedActions; normal same-service next submit now recovers committed/absent originals without test-side recovery or replay. The manager-side staged-key workaround from receipt031 was removed.

ICB-06 uses the preparer's existing normalized overridden-field attestation. A captured current component, including explicit clear, combined with actual prepared `messages` override is rejected as safe `CONTEXT_CURRENT_UNREPRESENTABLE` before binding/issue. Initial, assessed/derived and final synchronous checks use the same evidence. Manual/auto reduction blocks before summary/publication with existing `source-unrepresentable`. Adapter raw precedence is unchanged; non-message options and direct no-current legacy callers retain their contracts. There is no body substring/equal-text authority inference.

Successful read/list callbacks use the resolved lexical target and exact main Session object. Outside-root and canonical-escape reads remain reference content, mapping uncertainty blocks that selection, and successfully read bytes are retained. Invalid digest/page requests do not queue targets. `instruction_scope` is included inside the existing final JSON page budget. P/A retirement follows actual successful main completion or genuine recorded human promotion, not labels/turn IDs/issue alone. Incidental targets use normalized lexical path+kind keys, Windows case-fold comparison and deterministic code-unit order; distinct lexical aliases are not canonical-deduped.

## Qualification ledger

All Vitest runs were package-CWD runs with maxWorkers2/minWorkers1 (installed Vitest v3.2.7), sequential in this checkout. No actual user profile, credentials, external provider or remote was used. Model transports were owned loopback; profiles/workspaces were owned temporary paths. B0/settings230 and unrelated accepted W1/W2/P2 gates were not broadly rerun.

Latest acceptance receipts and source manifests are under `evidence/task-1/`:

| Gate / actual layer | Result | Receipt |
|---|---:|---|
| Final full core-agent suite after ICB-06 (includes original protocol/current/recovery/settlement controls) | **57 files / 512 tests; exit0** | 062 |
| Core representability/current protocols/recovery/completion/held summary short matrix | **65/65; exit0** | 060 |
| Actual assembled Chat/Responses/Anthropic, project/saved/disabled/zero policy | **12/12** within focused **21/21**, then executor qualification | 019, 055 |
| Actual Chat raw messages / Responses raw input: zero issue/handoff/P consumption; temperature positives preserve precedence | **4/4; exit0** | 059 |
| Actual manual/auto reduction blocked before summary/publication; direct no-current legacy and explicit-clear controls | **4/4** (also included in final512) | 060, 062 |
| Executor connected/affected suite: new instruction controls plus real context recovery, partial retry, received cancellation, S1 schedule and producer close/result controls | **19 files / 123 tests; exit0** | 055 |
| True full-range target fixture: N3, N257 with revisit, JSONL130 cap/recovery | **3/3; exit0** | 064 |
| Original runtime publication: finite management, dedupe/no-retain, setup/lease failure, actual install/absence, Stop and close | **24/24; exit0** | 048 |
| Same real service submit: committed/absent × Stop, repeated still-unknown submissions, changed saved generation/source, original issue separately counted | **4/4; exit0** | 051 (also055) |
| Actual registered read scope: external/canonical escape/mapping fault/revoked during mapping/foreign Session | **5/5; exit0** | 031 (also055) |
| Same-text dependency held prepare: rebuild before issue without extra text record; memory-only budget calls do not publish/send | **1/1** | 019, 055 |
| Saved policy: other-store writes/reset/rename, draft/corrupt/deleted/initial-corrupt, first-missing viability/EACCES/broken link/stale leaf, failed atomic rename, first coverage failure/recovery, joined held reload | **9/9; exit0** | 033 (also055) |
| Independent original view/pin and same original close retry; replacement cleanup debt | **2/2; exit0** | 028, 031, 055 |
| Real trust+policy+IA shared-watch borrowers, injected first original close faults and parent-last close | **1/1; exit0** | 043, 055 |
| Connected real JSONL accepted list result through original IA lease-close failure and same-service retry, no redispatch | **1/1; exit0** | 046, 055 |
| Newer pending read not consumed by older completion; failed issue retains P union; later wave retires old targets; cold JSONL preserves history/latest current | **3/3; exit0** | 040, 055 |
| FS owner full suite, including byte-budget pages and failed page no-queue | **94/94; exit0** | 041 |
| Affected IA host/pending/source-recovery controls (real shared leases) | **25/25; exit0** | 042 |
| Actual run/SDK stdio/ACP stdio/explicit-model headless main entries and affected CLI approval/retention/protocol/EOF/current controls | **6 files / 23 tests; exit0** | 068 |
| Final typed-current CLI oracle, after type-only spy typing correction | **2/2; exit0** | 072 |
| Actual Desktop main plus original Desktop compaction/close-retry controls | **5/5; exit0** | 069 |
| Affected package typechecks: core-agent, runtime-context, session-executor, instructions, fs, desktop-gateway, CLI | **all exit0** | 063, 070 (non-CLI), 071; type-only API narrowing rechecked078–080 |
| Original CLI build-dist owner | **exit0**, esbuild0 warnings; original dynamic-import qualification warnings retained | 074, final081 |
| Original Gateway build/copy owner | **exit0; 242 packages copied** | 075, final082 |
| Built CLI controlled main + copied Gateway factory/profile/readiness/source closure | **both child exits0; 6 copied source hashes matched** | 076, final binding084 |
| Reachability initial once run | **exit1:405 rows,19 new relative to seed** | 073 |
| Root-authorized reachability rerun after actual type-only public export retirement | **exit1:404 rows,18 new relative to seed** | 083 |

Receipts061 onward record UTC start/end, argv, package CWD, numeric exit, BASE/HEAD and changed-source SHA-256 manifests. Earlier raw logs preserve actual Vitest CWD/start/duration/results; their command/source-phase dispositions are recorded here and in their named receipts rather than fabricated contemporaneous hashes. Receipt084 has final selected source/copy/donor binding; final Git binding has the committed tree/range.

055 predates ICB-06's newly required guard; the new changed boundary was separately tested in059/060 and the complete core owner was rerun as062 because this was a material new common-path concern. Unchanged FS/IA/runtime implementations reuse their recorded affected-owner results. The final target gate064 exercised the resulting assembled implementation. This is not a claim that an unrelated entire monorepo or protected Gateway test was run.

## Exact long-gate layers and raw mapping

The N257 case is **standalone nondurable SessionService**, not JSONL execution. The fixture creates an empty coordinator/header to obtain an ID, but passes no coordinator into the service for that case; its execution events/outcomes are memory-owned. Its main loop starts through one `service.submit`, with recorded `human/request`, producer `session.prompt`, input text `visit sequential directories`. Each actual HTTP answer supplies a `read-N` list_dir tool call. The real Agent/registry/batch prepare/dispatch executes the registered tool, performs real readdir and the instruction callback, and constructs its original M61 result before the next main request. There are exactly **257 tool/call, 257 dispatch, 257 result** records. It is not manager-helper target queuing.

Only the final revisit uses the registered definition's `execute` directly with the exact main Session, then `Agent.followup` with unknown direct provenance. That revisit does not claim an additional original tool/call/result chain. The separate N130 case passes the real coordinator and uses real JSONL model acceptance, batch dispatch/results and a subsequent genuine service human submit. Other narrow opposite-completion, reference/mapping and concurrent-wave controls also call registered definitions directly at precise real filesystem barriers; their layer is stated separately from the full producer-chain cases.

`064-call-callback-request-sample.json` is a raw sample extracted from the final proof:

- `read-0` call seq8, list_dir args point to actual `workspace/d0`.
- Dispatch seq12 references original eventSeq8.
- Original result seq13 has dispatched/succeeded M61 inline `{entries:['AGENTS.md'], instruction_scope:{status:'queued'}}`, encodedBytes65.
- Next prepared view is exactly cwd+d0, 4 candidate slots, complete/ready.
- Next physical request ordinal1 is 28,973 bytes, SHA-256 `9f0a2969be44c058cf5d9089e7e77c013cbe447214342d4263a5a472a77b97ed`, and contains required cwd plus d0 current text.

`target-proof/targets-257.json` contains all259 request hashes/current prefixes, first/middle/last raw-body samples, original events and all259 prepared snapshots. Every prepared snapshot is complete/ready. Including revisit, **259 views opened; before close258 closed/live1; peak2; after close259 closed/live0**. All257 directory steps have full ancestry and only their exact incidental target text. N130 remains an honest over-cap block, then a genuine small human task recovers without erasing its130 original results.

N257 took376,220ms; whole064 file386.57s. These are **end-to-end fixture timings**, including actual observation/selection/main processing, whole SSE frames, retained request bodies, assertions and evidence serialization. No component profile isolated a CPU cause. Earlier durable timeout013 and failed long oracle025 remain measurements, not green gates or proved product-root-cause diagnoses. R6 must separate test-harness/SSE/retention/assertion costs from product costs; no performance success or budget tuning is claimed here.

## Source binding after the long run

064 ran against a frozen60-path manifest. Final packet has62 changed paths. `084-selected-source-shipping-donor-binding.json` proves:

1. The only changed path among064's bound paths is runtime-context/index.ts, removing the unnecessary named interface export. Its source SHA changed `55ae13f0...` → `14bcb5a9...`; `077-type-erasure-binding.json` proves identical emitted JS SHA `a8bff595d1aa5d78a37bc710d9ca72f7afde1db7feeb92d114647b65e4a77faa`.
2. The two additional modified paths are the root-approved CLI test-only oracles (`context-instructions.test.ts`, `sdk-approval.test.ts`). Their runtime/product dependencies for064 did not change. 065 RED is preserved, strict current-prefix/history and exact queued-metadata assertions were qualified by068/072 and final CLI types071/080.
3. Old tested and final rebuilt CLI bundles are byte-identical, SHA `9ac7c70ca2fbd8cbab3b3685927b5b8beb9f3d50b71f9ee40e7a7e28bc3867a4`.
4. Final Gateway copied host/manager/index/runtime-context/representability/fs-watch sources match final writer bytes. This is selected binding with explicit differences, **not** an assertion that every checkout source hash stayed the same after064.

076's diagnostic field named `physicalMainRequests:2` counted two Chat-path HTTP transports; it is not two main requests. The proof's ordinal0 is the qualified main request; ordinal1 is the ordinary session-title request (confirmed by its title-only system message). `076-qualification-layer-clarification.json` preserves this distinction. Copied-factory qualification is an import/factory/policy/observed-view control in the real copied graph, not a second Desktop-host physical-main claim. Actual Desktop source-host main qualification is069.

## Preserved RED, setup, oracle and interrupted attempts

No failure was relabelled as a green or a missing-interface failure as behavioral proof. Raw numbered logs remain under evidence/task-1.

| Receipts | Actual disposition / correction |
|---|---|
| 001 | Fixture setup: coordinator lacked exclusive owned lock. Corrected before causal caller RED. |
| 002 → 003 | Actual Chat body leaked outside-root and ambient-home sentinels; project-only observed main became green. |
| 004 → 005 | Actual selected disabled policy was ignored; exact saved-profile integration became green. |
| 007 → 008 | Same original IA lease first-close rejection made second release stick on memoized rejection; narrow same-handle retry became green, closed/read-cleanup fences retained. |
| 009–011 → 012 | Core fixture used wrong Agent.run argument position, then incorrect empty-batch/pending-source count oracles. Preserved as fixture/oracle errors; corrected original source matrix became green. |
| 013 | Original durable long controls timed out120s/30s; not feature RED or performance diagnosis. |
| 014 → 015 | Actual Windows ENOENT-under-regular-file selected missing defaults. ICB-02 metadata viability guard; later expanded controls are green. |
| 016 | Interrupted because whole-source freeze was not maintained while unrelated tests were added. Not green. |
| 017 → 018 → 019 | ESM spy setup error, then true opposite-read completion text-order RED, then deterministic exact-set green. |
| 021 → 023 | FS test-only package import resolution setup error; corrected to actual relative source import, no extra dependency install. |
| 025 | True258 transports and per-request current/ancestry checks finished; obsolete output-field oracle failed before revisit. Strict M61 oracle/same-fixture smoke061 and full064 supersede it. |
| 026 → 029 | Stale digest/page failure still queued a target; success boundary corrected and full FS owner green. |
| 027 → 028 | Replacement last-close failure still left manager current; same-original cleanup debt/fence became green. |
| 030 → 031 | True revoked-during-mapping and prematurely closed unknown publication views. 031 only qualified hold/close, not warm service recovery; manager staged workaround was later removed by ICB-04. |
| 032 → 033 | Initial corrupt profile then delete incorrectly installed defaults; actual failed strict observation remains unavailable until valid saved state. |
| 036/037 → 046/049/051 | Same real next service submit was blocked before render by S2; original optional absence also fell through committed conversion. True original-publication owner settlement repaired committed/absent recovery, with still-unknown/Stop controls retained. |
| 038 → 039 | FS test literal had unsupported ToolExec.ctx; corrected test typing. |
| 044 → 046 | Actual IA fault was correctly wrapped in observation AggregateError; exact nested original error identity replaced the wrong top-level-message oracle. |
| 050 → 051 | Fixture incorrectly expected external caller reason instead of original service-owned native AbortError/code20. Product Stop behavior was preserved. |
| 056 | Frozen long run intentionally interrupted for root's new raw-precedence control before final qualification. No source edit during this run; not green. |
| 057/058 → 059/060 | True raw messages body dropped rules yet successful handoff consumed P. Earlier raw-model positive hit existing adapter constraints (fixture error); temperature positive isolated the intended boundary. ICB-06 guarded actual attestation, including Responses. |
| 065 → 068/072 | Root-approved CLI oracle qualification: old user/plugin snapshot filter and missing new queued metadata; no product/budget change or wide matcher. Actual latest model prefix is checked. |
| 066 | Git add used repo-relative paths from package CWD; staging setup failed, focused test run still exit0. Subcommand exit was not separately captured; corrected staging recorded, not called feature RED. |
| 070 CLI → 071/072 | Optional prepare method confused vi.spyOn TypeScript overload; required actual factory capability typing corrected, runtime assertions unchanged. |
| 073 → 083 | Actual reachability failures. Root-authorized type-only API narrowing removed one unnecessary export row; no baseline/exemption/fake consumer. Still fail as below. |
| 084 first attempt | Inline PowerShell binding command parse error before execution; saved multiline binding script succeeded. No product/source effect. |

The two filtered offline ignore-scripts installs were only after actual TS2307 proved the newly declared fs-watch workspace links absent. Both used the existing installed cache (zero downloads); no provider/library/version/schema changes or reinstall loop.

## Reachability and unqualified obligations

073 was the requested once census. Root then explicitly authorized one rerun after a real type-only API retirement, producing083. Final actual result remains **exit1,404 rows,18 new relative to the2026-09-24 seed456,80 gone,2 inert pre-existing allowlist entries**. This packet changed neither baseline nor allowlist.

The eighteen rows are:

- core-session: CurrentContextComponent, exportConversationSeed, validateRuntimeContextRecord.
- instructions: InstructionPendingLease, createInstructionsSection.
- llm-seam: withPreparedRequests.
- runtime-context: installRuntimeContext.
- session-persistence: BootstrapCallerMetadata, BootstrapInitial, BootstrapLineage, BootstrapReceipt, BootstrapTarget.
- settings: InstructionMigrationMeta, SettingsRevisionGuard, SettingsWatchError, SettingsWatchOptions, SettingsWatchState, previewLegacyInstructionImport.

This is a seed-relative list, not eighteen features introduced by this packet. `073-base-export-bindings.json` records BASE declarations/references. Two directly affected old wrappers (`createInstructionsSection`, `installRuntimeContext`) lost their sole main caller because main now uses the actual observed/logical owner. Root found no remaining shipping consumer and reserved a recorded legacy-path/helper/test/document retirement for version close-out. They are **not** claimed qualified on speculative external compatibility. The other sixteen existing surfaces stay with their F1/IG/later owners; no artificial production imports were added. The new unnecessary named lease export was removed; the real render-retain/settleOriginals calls have actual assembly/service consumers.

Other larger-version limits remain explicit:

- ID child instruction managers/semantic inheritance is not delivered; main manager is not forwarded to children.
- IE native mutation fences/permissions are not granted by these read-scope metadata or pins.
- IF detached Code Mode ownership and IG management/import UI remain separate.
- Result-store lease's own service.close-failure retry gap (released/registration removed before awaited close) is still F1/R6. Only safe assembly dependency ordering was repaired; no replacement store owner was invented.
- R6 long-history/durable and test-harness performance qualification remains open. Timings above are not a CPU diagnosis or release benchmark.
- CLI original build still reports36 dynamic .ts imports/90 dynamic imports; tested current-instruction path works, but this is not blanket dist self-sufficiency or platform/installer/live-provider qualification.
- No whole0.1.13 release, product version change, Session format change, provider budget change, remote publication or actual account/provider qualification is claimed.

## Final handoff

The full BASE..HEAD diff, final source manifest, copied-source hashes, protected donor hash, selected runtime-erasure binding and Git tree/status are in evidence/task-1. ROOT MAIN legitimately advanced independently; this worker did not write its product checkout or mix the P5 donor into this branch.

After local commit the writer will stop all product/test source writing and preserve this branch/worktree for the fresh independent Sol full-range review. Important findings should return through root for scoped correction and review by the same reviewer. No merge/push/PR was performed.

## Fix round1 — I1, confirmed I1b, and M1

The original commit `829c369bd330ef41d1fea54b10bef18a022f7464` was not amended. The fresh full-range review in `task-1-review.md` found I1 Important and M1 Minor. The fix round additionally confirmed the same ownership error in the headless outer owner (I1b), and root explicitly authorized that narrow run.ts correction after its real caller RED.

- Correction HEAD: `3e5c8c413b8d10280cac6eded3663ec3b80eb3c9`.
- Incremental review range: `829c369bd330ef41d1fea54b10bef18a022f7464..3e5c8c413b8d10280cac6eded3663ec3b80eb3c9`.
- Updated full review range: `754681367a230bd106382ab1fb4a381c333b4aa0..3e5c8c413b8d10280cac6eded3663ec3b80eb3c9`.
- Same HOST/worktree/branch and GPT-6.1 Sol; no subagents. Only three changed paths: `packages/session-executor/src/assembly.ts`, `apps/cli/src/run.ts`, and new `packages/session-executor/test/main-instruction-construction.test.ts`.
- Raw commands, UTC/CWD/argv/numeric exits and correction-source SHA-256 manifests are in `evidence/task-1/fix-round-1/`. Original report before this append is archived there; all earlier receipts remain intact.

### Causal findings and correction

**I1 standalone:** receipt001 called the real standalone assembly with an owned temporary selected profile and a controlled Code Mode getter throw. A call-through observer captured the actual returned environment, not a replacement owner. After the constructor rejected with the original fault, the original policy initializer still became ready (generation2), with created1/close0 and modelCalls0. The probe's finally closed that same captured owner. This was a behavior RED, not a missing interface/import failure.

Environment acquisition and dependent manager setup now occur inside the existing construction/mount try. The instructions section keeps its original first registration slot through a deferred in-memory getter; skills and subagents retain their order. The earlier configuration callback can throw before any new environment is acquired. For errors after acquisition, the original disposal guard joins the same original owner. If cleanup succeeds, the original construction fault object is rethrown; an actual cleanup failure is preserved alongside it in AggregateError/cause. No borrowed outer environment is closed. M1's comment now describes logical admission reconciliation/full publication after hooks/claims, not an installed pre-step publisher.

**I1b headless:** receipt005 used real runHeadless, a temporary selected profile and a throwing `codeMode.mode` getter at actual assembly normalization. The function returned its original exit1/error while its real internally owned outer environment still reached ready/close0, modelCalls0. The prior mount catch returned before the separate run try/finally containing cleanup. Having a local outer handle had not made cleanup reachable. Root approved fixing this same cause in run.ts; no SDK/ACP source was generalized or edited.

The pre-existing cleanup closure over initialInput/assembly/ownedInstructions is now declared once beside those original handles and shared by mount failure and normal run-finally. Mount failure synchronously fences its owned environment, joins the original initial-input close once, preserves signal/run-end dependency order, and then reaches safe cleanup. The same already-attempted close Promise is passed for joining, avoiding an automatic duplicate close attempt. Failure of initial input close does not prevent closing an environment whose assembly borrowers have already closed (or were never returned). If assembly cleanup still fails, the parent environment remains held. A genuine run-end saving failure is preserved with the original mount fault. Actual cleanup failure uses the existing HeadlessCleanupError with its original same-owner retryCleanup; retry performs cleanup only, not model/input/action/appendRunEnd/environment reconstruction. Supplied borrowed environments remain caller-owned.

### Round1 qualification

| Receipt | Actual result / layer |
|---|---|
| 001 | Standalone causal RED, exit1: real created1, ready after reject, close0, original fault identity, model0. Captured original owner drained in test finally. |
| 002 | 2 RED / 2 positive controls: standalone leak plus swallowed real original policy-watch lease cleanup failure. Borrowed/owned later-failure controls also exercised. |
| 003 | Standalone correction controls4/4, exit0. |
| 004 | Probe setup error: top-level options.codeMode getter ran during runHeadless's initial option snapshot before environment acquisition. Not accepted as I1b proof. |
| 005 | True I1b RED, exit1: nested mode getter faults at assembly normalization after outer acquisition; real environment ready/close0, model0. Probe finally drains owner. |
| 006 | First combined standalone/headless correction5/5, exit0. |
| 007 | Preserved probe setup failure/unhandled rejection: synchronous registerSkills was incorrectly wrapped as async and was not an awaited barrier. Not GREEN despite its provisional filename. |
| 008 | Corrected real await at call-through acquireAssemblyResultStore, same returned original store; construction controls7/7, exit0. No store release/owner was replaced and no F1 result-store claim is made. |
| 009 | Full focused construction matrix10/10, exit0: standalone, borrowed/owned later failure, actual original lease cleanup failure/retry, headless borrowed/owned, HeadlessCleanupError same original lease retry, initial input close failure safe cleanup/no new admission/action, actual JSONL run-end absent, and original service outer close. |
| 010 | Existing standalone import/init/close selected controls4/4, exit0; unrelated assembly cases deliberately not selected. |
| 011 | Test typing failure, exit2: throw-only getter inferred void. Explicit never return annotations corrected only the fixture. |
| 012 | Executor owner typecheck, exit0. |
| 013 | Final construction plus original shared-borrower/unknown-publication close short gates:3 files/12 tests, exit0. |
| 014 | Original successful run/headless/SDK/ACP entry, typed-current and EOF short gates:3 files/8 tests, exit0. Actual controlled entry transports are distinguished from the zero-request failure probes. |
| 015 | CLI owner typecheck, exit0. |
| 016 | Original CLI build owner, exit0. Existing90 dynamic imports/36 dynamic .ts warnings retained; no whole-dist claim. |
| 017 | Original Gateway copy owner, exit0;242 packages. |
| 018 | Exact three-path SHA/base-blob/copy/donor and selected064-reuse binding. Final copied assembly matches writer bytes. |

The focused error probes create no model request or new native process. Actual environment/watch creation, readiness and close are call-through on original owners. The close-fault control fails the actual captured WatchLease.close operation, then retries that identical resource; the HeadlessCleanupError control verifies one environment/one lease/one getter, no model call and no event replay through retry. The real run-end control uses the actual JSONL backend frame returning absence. Every captured probe owner is closed in finally, including the RED runs.

### Exact reuse and remaining limits

064 was not rerun, per root's scoped-failure correction instruction. This is **behavioral selected reuse, not byte identity**. `018-selected-round1-binding.json` proves only assembly, run.ts and the new focused test differ from fix BASE. Core request/admission/response/reduction, instruction host/policy/views/targets, FS/observation/runtime publication modules, SessionService and the N257 target test are unchanged.

For064's successful service entry, the original outer environment is still supplied by SessionService. In assembly, only acquisition/manager initialization is moved behind the already evaluated configuration and inside the original guard; the deferred getter is used after that same manager is initialized. Section registration order, logical reconcile, prepared text/authority checks, publication/lease/result ownership and target retirement algorithm are unchanged. The new failure branches are not exercised by its constant off Code Mode configuration. run.ts is not064's target-test runtime entry. The changed headless success/close behavior is separately qualified by014. No claim is made that assembly/run source or rebuilt CLI bundle bytes equal the old ones; the new CLI bundle SHA is separately recorded in018.

No 512-test core rerun, six-minute target rerun, broad SDK/ACP expansion, reachability census or unrelated package suite was added in this correction. Existing reachability failure/legacy retirement/staged export obligations and all ID/IE/IF/IG/F1/R6/platform/dynamic-import limits above remain unchanged. In particular, the call-through store barrier does not fix or simulate successful recovery of the result-store lease's own known F1/R6 close-retry gap.

After the new local correction commit the writer again stops all product/test source writing. Both the original full range and the incremental correction diff are retained for the same reviewer's scoped re-review; no amend, merge, push or PR.
