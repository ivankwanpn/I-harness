# R4B target bootstrap: focused architectural preflight

2026-10-21. Read-only source inspection against the supplied accepted R4A/product checkpoint `678af03dd54659e22dd5f941112c06ec9917e812` and documentation checkpoint `5f95ce1825168b2f49cbe83df209cdc2806267cd`. This is a proposed contract, not implementation, runtime verification, or executable-plan acceptance. Only this report was written. R4C delivery revisions/epochs/wake/claim remain separate. No decomposition work is proposed.

Normative inputs: `docs/research/2026-10-16-context-engine-r4-seed-delivery-preflight.md` (B and detached-import addendum), `docs/research/2026-10-18-context-engine-r4b-current-owner-rebase.md`, and framework §§3–4, 9 in `docs/superpowers/specs/2026-10-15-context-engine-framework.md`. The previous source-notes file was used for navigation, then the owners below were read directly.

## 1. Finding and preferred boundary

Add one **bootstrap capability to the existing coordinator and managed-document owner**, with an immutable reservation in the target header, deterministic seed/completion batches in its existing fact journal, and explicit reconciliation of the original header, grant, and batch operations. The managed registry remains the only opening/resolved registry; the document's existing queue, capacity, private Session/index, quarantine, and operation lane remain the only target writer. The semantic projection/compiler is a separate pure input to this owner; this report intentionally leaves its item/native-compatibility representation to the root design.

The present APIs cannot implement this safely by composition:

| Existing evidence | Consequence |
| --- | --- |
| `packages/session-persistence/src/coordinator/mutations.ts:60` creates under the session lane/lease but calls a `Promise<void>` backend create. JSONL `packages/session-persistence-jsonl/src/index.ts:88` uses header-only `writeFile(..., {flag:'wx'})` without file sync or an outcome/receipt. | Creation rejection does not classify whether an existing target is ours, absent, or uncertain. B needs a qualified create/reconcile operation, not another random child ID. |
| `packages/session-persistence/src/coordinator/mutations.ts:101` serializes updateMeta, but JSONL `index.ts:245` rewrites with unsynced temporary `writeFile` + rename. `packages/session-persistence-jsonl/src/format.ts:40` whitelists metadata on parse. | Ordinary updateMeta is neither a durable bootstrap CAS nor a safe way to add an unknown header field. It would also lose an unrecognized descriptor on subsequent parse/rewrite. |
| `packages/session-persistence/src/coordinator/managed-documents.ts:17` has the one opening map and resolved map; `:30` loads under ownership and `:35` checks journal count against the loaded archive. | Integrate bootstrap/reentry here. Do not introduce a second bootstrap opening map or bypass this count check. |
| `packages/core-session/src/managed/view.ts:10` captures source/header and constructs the structural index; `:24` freezes the view. `packages/session-persistence/src/format/validation.ts:73` builds a managed Session header containing only current lineage/depth/origin fields. | A disk header rewrite cannot update an already captured header/index. New descriptor/lineage fields must survive parse → buildSession → capture → validation. |
| `packages/session-persistence/src/coordinator/managed-document.ts:152` drains the sole queue under the lane; `:183` creates a random batch ID; `:185` stores pending bytes in the live document; `:362` reconciles only that pending batch. | Reusing importSeed unchanged does not provide stable logical reentry or cold bootstrap reconciliation. Keep ordinary fact semantics, add a narrow fixed-identity bootstrap admission. |
| `packages/core-session/src/managed/groups.ts:152` allows seed import only at seq0 into an empty target and strips operational authority by validation. | Preserve this raw-import defense. A new semantic seed must have its own explicit validated representation/target compiler, not weaken raw validation or pretend proof-stripped raw records are valid. |

The true existing backend strength is exact append bytes + held lease + file fsync + receipt, with same-issued-byte reconciliation: `packages/session-persistence-jsonl/src/backend/fact-journal.ts:67`, `:81`, `:89`, `:115`. Complete matching bytes may be sync-confirmed; a matching partial suffix may be truncated and synced to prove absence. Conflict/unknown quarantine new work. `readJournalPrefix` at `:50` likewise truncates a torn final frame and syncs. This is a local file/journal guarantee, not a transaction with artifact pins and not a universal power-loss guarantee for directory entries: directory fsync is best effort on Windows in `backend/session-io.ts:29` and `backend/format-upgrade.ts:72`.

## 2. Three viable shapes

1. **Preferred: immutable header reservation, then seed and completion batches.** A small header descriptor declares the original operation, compiled prefix and initial-input digests. Existing exact journal writes install the bounded seed; a final batch records bootstrap confirmation and, where applicable, the one new delegated input. Artifact owner confirmation occurs between reservation and completion. Advantages: preserves actual journal receipts, explicit crash cuts, no rewriting a growing archive, and a discoverable blocked target. Cost: new header/batch semantics and explicit blocked-opening behavior. A cold incomplete target needs the exact original payload to continue; lacking it is a typed recovery refusal, not a reason to recreate from changed source.
2. **Atomic whole initial file installation.** Coordinator stages header + entire bounded semantic seed + optional initial input, then publishes the complete file in one qualified create/empty-target CAS. Grants are still a separate operation and publication must remain fenced until confirmed. Fewer journal phases, but an existing-empty rewrite still requires cache exclusion, no-clobber/CAS/reconcile and durable readiness semantics. It also needs a new whole-file operation instead of building primarily on the owned-batch receipt boundary. Viable if root prefers one larger bootstrap physical operation.
3. **Header/index transaction inside an already open pristine document.** Add a private same-view reheader/index replacement capability and bootstrap reservation to its queue. This could accept an unprepared cached empty target without reopen. It requires changing the frozen-header design, tracking every live source/action/received-input attachment and defining visibility to retained aliases. More invasive and harder to qualify. Do not approximate it by close/evict/reopen while external aliases remain live.

Choice1 intentionally **refuses an unprepared cached empty target**. It supports uncached qualified existing-empty targets and cached reentry for the same already-declared operation. This is the smallest coherent interpretation of “qualified target”; if root requires transparent first-time bootstrap of an already published empty view, choose3 explicitly and qualify same-view installation. This decision cannot be hidden in updateMeta.

## 3. Proposed closed interfaces

Names below are proposals. Reuse the root's `SemanticSeedV1` and native compatibility decision; do not establish a competing semantic DTO here.

```ts
type BootstrapSource =
  | { kind: 'session'; sessionId: string; formatVersion: number;
      prefixDigest: string; semanticRevision: string; selectionDigest: string }
  | { kind: 'detached'; contentDigest: string; semanticRevision: string;
      selectionDigest: string; declaredSessionId?: string };

type BootstrapTarget =
  | { kind: 'new'; sessionId: string; creation: BootstrapCreationMeta }
  | { kind: 'existing-empty'; sessionId: string;
      expectedHeaderDigest: string; expectedPrefix: JournalPrefix }
  | { kind: 'resume'; sessionId: string; operationId: string;
      manifestDigest: string };

interface BootstrapManifestV1 {
  version: 1; operationId: string; targetSessionId: string;
  source: BootstrapSource; seedCodec: 'semantic-seed-v1';
  seedDigest: string; seedLength: number; dependencyDigest: string;
  initial: { kind: 'none' } | { kind: 'delegated'; inputId: string; digest: string };
  // Includes creation/lineage/selection and compiler-version identity.
  manifestDigest: string;
}
interface BootstrapRequest {
  target: BootstrapTarget; manifest: BootstrapManifestV1;
  seed: SemanticSeedV1; initial: BootstrapInitialInput | undefined;
}
type BootstrapPhase = 'header' | 'dependencies' | 'seed' | 'completion';
type BootstrapOutcome =
  | { kind: 'ready' | 'already-ready'; receipt: BootstrapReceipt;
      document: ManagedDocument; initialInput?: { inputId: string; seq: number } }
  | { kind: 'not-issued'; reason: 'stale-source' | 'cancelled' | 'unsupported' }
  | { kind: 'blocked'; phase: BootstrapPhase; token: BootstrapResumeToken;
      reason: 'unknown' | 'payload-required' | 'dependency-unavailable' }
  | { kind: 'refused'; reason: 'conflict' | 'nonempty' | 'cached-unprepared'
      | 'wrong-view' | 'incompatible' | 'manifest-invalid' };

SessionCoordinator.bootstrapSemanticTarget(
  request: BootstrapRequest, guards: BootstrapGuards
): Promise<BootstrapOutcome>;
SessionCoordinator.inspectBootstrap(
  token: BootstrapResumeToken
): Promise<BootstrapInspection>; // actual header/prefix/phase, no credentials
```

`BootstrapGuards` is a host-created narrow capability (AbortSignal, synchronous `assertSourceCurrent()`/`assertTargetInstructionsCurrent()`, and injected artifact owner port). It is never part of model arguments or serialized data. The last source/instruction/Stop check and fixed-byte issuance run synchronously in the existing writer's `beforeIssue` boundary. No whole Assembly/Service parameter. Do not hold the session lane while awaiting another public method which itself joins the same lane; extract private unlocked helpers and reuse the existing managed registry promise to exclude open/bootstrap races.

Backend extension in coordinator-owned `PersistenceBackend` should be explicit rather than overloading updateMeta:

```ts
prepareBootstrapHeader(id, issuingOwner, expectedTarget, encodedHeader)
  : Promise<HeaderOutcome>;
reconcileBootstrapHeader(id, heldOwner, expectedTarget, encodedHeader)
  : Promise<HeaderOutcome>;
// HeaderOutcome = committed receipt | absent | unknown | conflict | not-issued
```

Both compare exact prior header/body prefix for existing-empty targets, or prove absence for new targets, under held ownership. Preserve exact unrelated metadata. Use fixed transaction-specific staging bytes/path and file sync; reconcile that same operation after rename/close uncertainty. An arbitrary partially written or mismatching header is conflict/blocked, never deletion. New-target create must not replace an unrelated existing file. Reentry must reuse the original immutable creation data (including original creation timestamp), not recalculate it. Staging is the backend's existing physical temporary-file mechanism, not a new authoritative bootstrap store.

Internally the ManagedDocument needs `admitBootstrapPhase(manifest, phase, fixedGroup, checkCurrent)` and `reconcileBootstrapPhase(...)`, restricted to the coordinator-created bootstrap capability. It must select deterministic batch IDs such as `bootstrap:<operationId>:seed` and `bootstrap:<operationId>:complete`, isolate these batches from ordinary coalescing, and retain the original encoded bytes/key in the existing `pending` state. Do not expose arbitrary caller-supplied batch IDs through ordinary fact ports. Cold inspection derives completed phases from the immutable descriptor plus actual verified frames/events; it cannot rely on a new process map.

The registry needs a private bootstrap attachment mode using that same map/promise and sole document, while public open/snapshot/attachment checks refuse incomplete bootstrap. A blocked-but-owned document may remain in the existing registry for reconciliation; it must not become usable merely because its internal construction promise resolved. Both `assertReady` and observable/snapshot guards need the persisted bootstrap disposition, in addition to current pending/quarantine checks. This avoids leaking an executable owner during the header-to-completion interval.

## 4. Identity, phases, reentry and cached targets

**Operation identity:** derive a durable child target ID from a trusted qualified caller operation, not content alone. For spawn, the current trusted inputs already exist in `packages/subagent/src/tools/spawn.ts:100` (actual session/callEventSeq/callId), with task submission and `subagent/start` at `:109`/`:127`. Forward an immutable host-only bootstrap intent to spawnChild, qualified by the real registry/delegation namespace and actual call, so distinct identical tasks stay distinct. Do not trust model-supplied session IDs or a handler bound to a different parent. For SDK/session-fork/detached imports add a caller operation token to the public DTO; one invocation mints it once and returns the same token/target on uncertainty. Legacy convenience callers may mint once per genuine invocation, but must not internally retry with another token. This is bootstrap identity only; it does not implement R4C result delivery keys.

**Manifest digest:** commit the exact semantic selection, compiler codec/version, source identity/revision, target creation/lineage fields, ordered dependency identities, compiled child event bytes/count and initial task/input digest. SeedLength is the number of actual compiled inherited archive events, not parent event count, semantic item count, completion marker or new delegated input. Freeze actual bytes before issuance. A manifest digest is integrity evidence, not authorization or proof that a source session exists.

**Phases:**

1. Pure source export and requested none/all/N/completed-boundary selection; validate target role/model/tool/permission floors. Capture the source coordinates and current instruction generation. Resolve target binding through its existing owner only for an actual execution request, obtain the root-designed compatibility disposition, and compile target seed. Recheck source/instructions after every resolver await before reservation.
2. Under the existing lane and lease, prove target eligibility and persist an immutable header descriptor with actual parentSession only when known, exact seedLength and bootstrap manifest digest. Target is now unpublished/blocked. For an existing-empty target require **zero archive events**, not `profile.blank`: JSONL blank means “no turn/start” and has a bounded probe (`index.ts:227`), not empty. No pending write-behind, other opening, action, source or runtime may race the qualification.
3. Confirm exact R4A artifact grants/pins through the existing artifact owner (below). Recheck source/instructions/dependency authorization after its awaits. Confirmations do not execute models/tools.
4. Admit one fixed seed batch through the document's sole queue and obtain its receipt. An empty seed has no empty fact frame (current encoder requires nonzero count at `packages/core-session/src/serialization/fact-journal.ts:42`); its immutable zero-length declaration supplies that boundary.
5. Admit a fixed completion batch containing a non-ignorable `session/bootstrap` confirmation and, for child creation, the single deterministic child-local `agent/input/admitted`. The new marker carries operation/manifest identity and dependency confirmation digest, has no human/action authority, and is outside the seed prefix. It may be ordered before the initial input within the same batch; both commit atomically. Session-fork/import without a new task commits the marker alone. Header stays immutable; phase comes from the verified journal. Only after header, seed, dependencies and completion receipts can ordinary document actions/publication proceed. `beginAction`, received-input registration and generic optional facts must reject while bootstrap is incomplete.

The existing initial-generation helper currently invents an input ID then admits input and opens generation (`packages/subagent/src/child/generation.ts:16`). Change it to consume the bootstrap-owned committed input/seq; it must not admit again. Generation/attempt allowance remains child-local, with current timeout and shared approval exception unchanged. `publishChild` must require this ready receipt and remove its production fallback input admission (`child/lifecycle.ts:23`). It presently schedules actual `runAdmitted` at `:78`; that remains after confirmed bootstrap and current publication fence.

**Eligibility matrix:**

| Target encountered | Required behavior |
| --- | --- |
| Absent new target | Reserve the supplied stable target ID. An existing file never means “choose another random ID.” |
| Uncached existing-empty target, exact expected header/prefix | Atomically install descriptor/header under the lane, then construct the sole managed view/index from that confirmed header. Preserve unrelated metadata. |
| Cached/opening target with same immutable manifest | Join existing registry operation or reconcile its pending phase; return the same view/receipt. A same-ID different digest is conflict. |
| Cached empty target without descriptor | Explicit `cached-unprepared`, no bytes changed. Caller must use the bootstrap entry before publishing an owned view. Exact-view attachment rules still apply. |
| Any unrelated nonempty/live target | Refuse, even if it has no turn/start. Never reinterpret its current suffix as seed. |
| Same completed bootstrap with later live suffix | Inspect/adopt the historical bootstrap receipt without appending seed/input again. Reopening may attach normally; it must **not launch the initial task again**. If a prior launch/claim is uncertain, require existing executor recovery or report blocked; B supplies no invented exactly-once model/effect claim. |

**Unknown and cold behavior:** header uncertainty reconciles original header bytes first. Seed/completion uncertainty uses the existing pending batch/backend reconcile; no new append until disposition is known. A cold opener recognizes the descriptor **before normal repair/open/runtime construction** and keeps incomplete targets blocked. It validates full committed frames and their deterministic IDs/digests against the descriptor. A matching torn suffix is handled only by the original journal's proven-absence recovery, never whole-target rollback. A missing seed/completion can resume only with the exact original payload and still-current authorization; source changed during the wait means stale/blocked, not fresh export under the same identity. If payload is unavailable, `payload-required` remains durable/discoverable. Complete bytes are adoptable after fsync confirmation; a lost response is not permission to reissue a logical spawn. Stop before issuance cancels; after issuance only passive original reconciliation is allowed, with no newly granted launch authority. Closing a blocked document may legitimately require recovery, as current `managed-document.ts:389` already does.

This permits cold **recovery or explicit refusal**, not an unsupported promise that a header digest can reconstruct lost semantic content. Autonomous cold continuation of an uncommitted seed would require persisting that frozen payload in the same target journal/staging operation before external awaits; choose that extension explicitly if required, rather than retaining a second raw store.

## 5. Artifact confirmation is a necessary narrow owner extension

Current `ContextOutputService.grant` is `Promise<void>` by ID (`packages/context-output/src/types.ts:42`, `service.ts:150`). Managed `grantResults` reads the artifact's current operation/ref, authorizes access and publishes a target-document pin (`artifact/ownership.ts:136`). The pin uses the **original artifact operation ID**, not a bootstrap operation (`:144`). `publishPin` writes pin and access pointer in two operations (`artifact/pins.ts:9`); `atomicJson` can resume exact deterministic pending bytes (`artifact/io.ts:32`). `readPin` validates the ACL pointer plus real document pin (`pins.ts:17`). This existing owner/store is suitable, but ID-only void grant has no public exact revision/codec/contentDigest confirmation or explicit uncertain-grant reconciliation.

Propose a host-only `confirmBootstrapDependencies({operationId,targetSessionId,source,manifestDigest,refs}, current)` → `confirmed {dependencyDigest,witnesses}` | `blocked {unknown|unavailable|conflict}` on the existing ContextOutputService/artifact owner. Validate full immutable `ManagedArtifactRef` values and catalog/member identities, actual source authorization, target document identity and original artifact operation. Query existing pins/ACLs; after uncertainty reconcile the same intended pin/access bytes under the existing artifact mutation chain. Do not call a fresh generic grant and label that reconciliation. No new grant store or owner array. A confirmation receipt in a session is evidence of the completed step, never independent ACL authority; actual access continues through authorized reads.

R4A dependency catalogs can represent many members (`packages/core-session/src/results/types.ts:23`); a blanket call to grant's current <=100-ID API is insufficient. Stream/iterate exact declared catalog members through the current owner with bounded metadata processing and retain the catalog/member pins and membership evidence. Avoid fetching artifact bodies. Distinguish unavailable retention entries from required durable refs in the root semantic DTO.

Current `session/inherited` hook only scans legacy `context/result-ref` events and may skip expired/unavailable refs (`packages/session-executor/src/context-output.ts:61`). It cannot certify the R4A exact semantic dependency set. Route semantic inheritance through the new bootstrap confirmation once; retire this hook's semantic-grant decision or restrict it explicitly to legacy compatibility. No duplicate grant after seed publication. `confirmResultOwner` (`artifact/ownership.ts:168`) is for the original registered result source scope and cannot be borrowed as a child-import scope.

## 6. Anonymous imports and version fence

Anonymous detached content has `source.kind='detached'` plus a content digest; omit parentSession. A declared header sessionId is only declared provenance until the actual source owner validates it. Do not invent `parentSession=targetId`, a synthetic source ID, or local human authority to satisfy current input validation.

There is a real existing compatibility seam: `packages/core-session/src/conversation/input-preparation.ts:25` requires parentSession for derived `seedInputContext`; `conversation/state.ts:21` skips inherited operational input state only when parentSession exists; generation validation at `conversation/generation.ts:65` uses seedLength and at `:69` requires a real parentSession for delegated origins. The new format must distinguish **declared seed boundary independent of parent lineage**. Extend these shared scope validators/readers to recognize the explicit bootstrap/semantic-seed boundary for anonymous content while keeping parent identity absent. The new local delegated task still needs its actual trusted caller origin; an anonymous import alone is observation and cannot open a human/delegated generation. Until this semantic scope is implemented, refuse linked anonymous import explicitly; do not strip links or fabricate identity to pass validation.

Use a **new incompatible Session format (next unused, currently11)** plus explicit semantic codec1 and bootstrap marker version1. Current Session format is10 (`packages/core-session/src/events/types.ts:256`), and unknown header properties alone are silently discarded by current JSONL parse/build paths. Do not carry new seed/ready/anonymous-boundary execution semantics silently in format10. Actual predecessor coordinator preflight rejects version>10 before repair (`packages/session-persistence/src/format/validation.ts:24`; `coordinator/load.ts:37`, `:99`), and core `fromJSONL` rejects versions beyond current (`serialization/jsonl.ts:32`). These are the genuine existing incompatible-execution fences; verify them using predecessor binaries/fixtures in the executable plan, including header-only interrupted targets.

Raw JSONL `backend.read` currently does not itself reject future versions and falls back to raw event-line parsing outside6–10 (`session-persistence-jsonl/src/index.ts:141`). Do not claim every old low-level metadata/read primitive refuses. B must make new backend read/profile/repair behavior explicit, preserve the coordinator's before-repair fence, and require predecessor execution readers to fail without mutation/auth/model work. A non-ignorable new bootstrap event provides an additional event-validation fence when metadata is stripped, but is not a substitute for the header-only format fence. Upgrading an old session does not manufacture ready markers/receipts for legacy imports. Legacy reading/raw structural export remains distinct and does not acquire new bootstrap authority.

## 7. Caller changes and decisive real-entry controls

`forkSession` currently profiles/opens source, creates target metadata, then separately opens/imports (`packages/session-persistence/src/fork.ts:19`). Switch this call chain to pure semantic selection plus the one bootstrap entry, with an operation token returned on blocked outcomes. Preserve completed-turn/atSeq meaning and refusal at inseparable boundaries. Keep `completedTurnPrefix`/raw remapping as an explicitly raw export path where still needed, not as the semantic implementation.

`spawnChild` currently exports before awaits (`child.ts:28`), awaits result source (`:51`), randomly creates child (`:55`), imports, opens input/generation, resolves declared model (`:68`), emits inherited hook (`:81`), assembles then publishes (`:90`). Replace only bootstrap/confirmation ordering with the above capability; preserve default none, pure role gate, current host instructions, role model override, tool restrictions and permission floors. Source captured before `results.forSource`/model/grant awaits must be checked again. `openChildDocument` (`child/document.ts:7`) becomes a ready-result attachment, not a second importer. Standalone uses the same semantic compiler/invariants and deterministic in-process intent but advertises no cross-process guarantee; do not instantiate a durable coordinator secretly.

`openExecutorDocument` is the actual detached attachment entry (`session-executor/src/lifecycle/managed-document.ts:18`), reached from executor assembly and durable-session public factories. It should compile a pure bounded semantic export and invoke coordinator bootstrap **before** normal `openManagedDocument`; stop calling `compileDetachedSeed` → ordinary open → importSeed as a separate path. `detached-seed.ts:7` currently clones the entire Session through captureLegacyFact and requires predeclared exact lineage for linked inputs. Retire this clone from semantic import, preserve exact supplied-view validation, and return typed cached-unprepared/nonempty/anonymous-incompatible outcomes. Every team/SDK/Gateway caller must enter through these public owners with its own trusted intent; root's consumer plan must cover their actual entries, not invent extra low-level importers.

Required independent controls (proposed, not run):

1. Drive actual managed **and standalone** spawn_agent/all from an accepted/dispatched parent spawn without result, with parallel sibling calls. Independently inspect child's first prepared request, current input/task, whole omitted parent unit observations, role/current host instruction surface and target admission. Assert no parent call replay, no synthesized result, no parent action/attempt/permission/calibration inheritance, and zero child model/tool execution before ready. Include none/N/completed and strict boundary refusals.
2. Use the actual public detached executor factory with anonymous content, linked derived inputs, uncached empty target, predeclared cached same-operation target, cached unprepared empty target, nonempty target and supplied wrong view. Read durable header and actual managed view/index; compare declared seedLength to committed inherited event count and demonstrate first local input lies outside it. Anonymous linkage must work via new explicit scope or refuse without bytes changed.
3. Inject cuts before/after header publication/sync/response; between individual pin and ACL publication; after seed fsync/before install/response; after completion+input fsync/before response; during close; and cold reload after each. Count **one stable target, one seed phase, one initial input**. Reentry with same op/digest adopts; changed seed/dependency/task/creation data conflicts. After original write uncertainty no random spawn, second import, destructive target deletion or generic grant replay. Count actual execution separately: a complete receipt is not permission to repeat an already launched/uncertain initial action.
4. Mutate source, role/host instructions or dependency authorization during result-source/model/grant awaits. Assert stale/no issuance at final guard, or explicit blocked reserved child after earlier confirmed phase. Stop before issuance cancels; Stop after issuance permits passive reconcile only. Read-only export/inspection must record zero auth/provider/model work.
5. Export a100MiB consumed parent with small effective projection and exact R4A dependencies; independently compare target first request against source effective content and artifact identities. Seed and extra clone size must track effective items/dependencies, not consumed bodies. This is not an R6 whole-archive streaming or cold-memory claim.
6. Open new-format ready, header-only and unknown bootstrap fixtures with the actual accepted format10 predecessor execution/import paths; require incompatible refusal before repair/auth/execution and unchanged bytes. Legacy sessions remain readable under their actual contract without backfilled certificates.

## 8. Root decisions / unresolved limits

- Decide whether cached unprepared empty targets may explicitly refuse (preferred), or require the larger same-view header/index installation design. Framework insists coherent installed state and sole ownership; current immutable view cannot satisfy transparent cached reheader by metadata patch.
- Decide whether cold incomplete targets may require exact original payload/recovery refusal (preferred narrow guarantee), or must autonomously resume after source changes/disappearance. The latter requires durably staging the frozen semantic payload in the same target operation before awaits; a digest alone cannot recover it.
- Freeze the new semantic seed/anonymous-scope DTO with the root projector/native design, then choose the next unused format number. There is no contradiction requiring parent identity: current validators are the limitation, and B must extend explicit seed scope rather than fake lineage. Framework's ownership constraint rules out a second writer/store.
- Exact artifact grant/pin confirmation is a missing public capability, not proven by current void grant. Its narrowly scoped extension is necessary B work. No assumption that existing `confirmResultOwner` or the legacy inherited hook already covers semantic dependencies.
- Initial model launch after a completed bootstrap remains governed by existing generation/action recovery. B can deduplicate the seed and initial input and refuse after launch uncertainty; it cannot claim exactly-once task consumption/effects from a bootstrap receipt. R4C must not be smuggled into this unit to hide that limit.

No implementation, tests, builds, runtime probes, Git/index operations, release changes, pushes, merges or tags were performed for this preflight.
