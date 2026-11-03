# Context redesign: adoption traceability and architecture closure review

Date: 2026-10-15. Review scope: current design/research documents and their existing reference reports. This is a design review, not a repeated source audit, implementation approval, or runtime verification. No providers, tests, builds, account data, product edits, or Git mutations. Only this temporary report is written. Existing research baseline remains `81bca938`; the task's current workspace HEAD is `1b605d0e`.

## Judgment

The proposal incorporates the principal transferable strengths of **all five** references. Its archive/snapshot distinction, typed ordered exchanges, protocol-owned replay, final request measurement, staged reduction, durable replacement, artifact-backed outputs and child delivery are coherent. The prior independent review's substantive fixes are already incorporated. No reason to replace the recommended single ContextEngine with per-provider conversation engines.

However, “all five were considered and their main principles adopted” is supported; “every worthwhile mechanism is completely specified and ready to implement” is too strong. The present package table is a responsibility sketch, not yet an enforceable dependency/ownership framework. Four closure items below should be expressed as architecture contracts before a detailed execution plan. Complexity need not be reduced by dropping capabilities: isolate policy, persistence, execution and protocol effects so complexity remains reviewable.

Sources: spec §§2–10; reassessment §§4–8; existing `codex-audit.md` §§8–9, `dsh-zcode-audit.md` “Transferable design for IH”, `pi-opencode-audit.md` recommendations, unified-format addenda, and `design-review.md` resolution table.

## Adoption → IH owner → invariant → verification matrix

All owners below are proposed target responsibilities, not assertions that the runtime already implements them. Fixture names are proposed acceptance IDs; existing R0–R6 stages provide placement.

| Reference strength | IH module/owner | Required invariant | Verification |
| --- | --- | --- | --- |
| Codex ContextManager vs rollout; complete replacement checkpoint | `core-session` archive/projector; ContextEngine `snapshot`/`commit` | Latest committed manifest plus accepted suffix reproduces active semantic context; archive size does not become prompt size. | R1/R3/R6 `checkpoint-resume-equivalence`: live/cold/rewind parity; crash cuts around record/flush/install; >100 MiB cold-load measured separately. |
| Codex live-clone output truncation; OpenCode V2 structured retained output | Result-ingress envelope; `output-retention` artifact implementation; `context-output` preview projection | Preserve the outcome and retention status; publish a resolvable durable ref only after retention; preview/media bounds cannot silently expand at fan-in or reread. | R4 `retention-ingress`: large single line, UTF-8, media, structured MCP/Code Mode results, storage/quota failure, GC while referenced, bounded paged read. |
| DSH replacement surface and ordered blocks/replay sidecar | `core-session` semantic exchange/checkpoint DTOs; `llm-seam` replay contract; `llm-*` adapters | Canonical ordered content and native sidecar stay aligned through keep/drop/reorder; unsupported ownership/version never replays opaque state as compatible. | R1/R2 `ordered-replay`: interleaved text/reasoning/parallel calls; sidecar count/type/version mismatch; native blocks survive compatible resume. |
| DSH durable replacement progress; ZCode microcompact→summary | ContextEngine `reduction`/`admission`; `compaction` summary provider | Deterministic old-output reduction precedes summary where useful; every candidate is assessed under the same target binding; changed, target-ready and hard-fit differ. | R3 `reduction-progress`: prune changes but remains over target; no-shrink/irreducible candidate; finite multi-stage attempts; summary request itself too large. |
| ZCode prospective runtime history and usage anchor | ContextEngine `snapshot`/`admission`; `token-meter`; adapter preparation | New human/steer/child input, current instructions, final tools/schema/media and options are included before certification; anchors carry request lineage, route and projection identity. | R2 `prospective-input`: huge new prompt, schema growth, hook changes, model change, moving Anthropic cache marker; exact sent artifact matches certification. |
| PI branch/checkpoint/tail and context edits | `core-session` projector/importer; ContextEngine snapshot | Failed attempts remain evidence but do not enter valid prompt; recent tail remains typed; branch/context edits invalidate relevant samples and native replay. | R1/R2 `branch-edit`: rewind after summary, omit failed attempt, preserve current human input, model switch, legacy unknown authority. |
| PI native signatures; DSH/PI shared model with protocol escape hatches | `llm-seam` capability/compatibility contracts; each `llm-*` adapter | Shared semantics do not erase ordered native replay; local validation claims only observable structure/compatibility; opaque-only incompatible handoff blocks. | R2/R3/R4 six-route fixtures: signed/redacted reasoning, hosted tools, account/endpoint changes, expired server refs, cross-model child fork. |
| OpenCode V2 context epoch and durable input admission before advisory wake | `session-executor` ownership; session delivery store; `subagent`; ContextEngine reads admitted facts | Durable result admission and logical claim dedupe survive restart; wake may repeat; Stop and branch/epoch disposition are checked before promotion. | R4 `delivery-epoch`: child settles during summary/Stop/rewind; crash before/after admission and wake; repeated wake; no duplicate dispatch or missing durable result. |
| OpenCode logical call vs physical attempt; DSH/ZCode typed retries | Execution coordinator/attempt ledger; ContextEngine `recovery`; adapter transport | One shared attempt allowance covers nested physical attempts; identical-payload retry requires eligible transient failure; recovery changes relevant pressure without replaying effects. | R5 `nested-attempt-budget`: SDK+transport+summary retries, stream error before/after visible output and tool dispatch, restart between recovery decisions. |
| Five references' archive/window distinction; explicit limits from their weaknesses | `token-meter` primitives; ContextEngine BudgetPolicy; adapters; observation DTO | Archive bytes, semantic estimate, measured provider input, cache accounting, output reserve, wire bytes and billing remain distinct; UI performs no prepare/auth/network work. | R0/R2/R5 separate oracle/control for each dimension, unknown limits and remote refs; UI read spy; final serialization overlays cannot evade byte gate. |

Use this matrix as a living traceability table: each execution task should point to its owner, invariant, fixture and old production owner to retire. Avoid treating source similarity as acceptance evidence. R0 independent protocol/measurement controls remain essential.

## Architecture closure items

### 1. Define dependency direction and effect ownership (P1)

**Current evidence:** spec §8 puts decision/transaction in ContextEngine, data in `core-session`, measurement in `token-meter`, summary generation in `compaction`, protocol in `llm-*`, and owner/lease in `session-executor`. It does not state who is allowed to import whom or how transaction persistence reaches the actual session owner.

**Risk:** `core-session → context-engine → compaction → core-agent/core-session` cycles; adapters calling policy; ContextEngine accumulating JSONL parsing, transport auth, tool execution, child scheduler and artifact GC. Folder splitting alone does not prevent a god package.

**Contract to add:**

- `core-session` owns stable semantic/persistence DTOs, projector/importer and archive representation; it does not import orchestration, provider implementations or Desktop.
- `llm-seam` owns protocol-independent preparation/capability contracts; adapters own native encoding/validation. `token-meter` owns units/measurement/calibration primitives and no session execution policy.
- ContextEngine consumes immutable inputs and narrow injected ports for candidate preparation/assessment, summary generation, artifact resolution and checkpoint publication. It does not instantiate provider clients, authenticate, execute tools, schedule children, parse raw JSONL or implement storage GC.
- `compaction` becomes a summary/reduction implementation injected at the composition root, not a second admission owner and not an importer of the engine implementation. Put any shared port DTO in a lower contract layer to avoid a cycle.
- `core-agent` orchestrates model/tool phases; `session-executor` holds the durable owner/lease and supplies a fenced publication port. The archive writer performs compare-and-append/flush; the engine proposes and validates replacement, then installs only a confirmed committed manifest. A stale owner cannot publish or start transport.
- `subagent`/delivery owner persists settlement, inbox/outbox and wake state; ContextEngine includes their admitted facts but does not become the scheduler. `output-retention` owns storage/retention, `context-output` owns model-facing projection, and `core-tools` normalizes every ingress path to the shared envelope.

Add import rules and package-surface checks to the execution plan. Give each subdirectory one input/output contract and state owner. Keep root's precise oversized-file census/mapping as a separate implementation-scope artifact.

### 2. Close physical-attempt and stream-acceptance ownership (P1)

**Current evidence:** §§2/5/7 already require every physical request to pass admission, bounded summary calls, bounded recovery, no tool replay, and stream-settled exchange identity. The reference reports specifically warn that SDK/transport/session retry counts multiply, and ZCode's speculative streamed tools enlarge the recovery surface.

**Add:** a logical model action has durable attempt lineage and a shared remaining-attempt/deadline allowance. Main, summary, changed-input recovery, provider count when relevant, SDK retries and WS→HTTP fallback consume their appropriate physical-call allowance; a lower transport cannot silently reset it. Define whether non-sampling count calls share a sampling allowance or a separately bounded admission allowance—do not hide them.

Name the acceptance boundary for partial streams. Preserve raw failed deltas as observations, but specify which accepted exchange/dispatch facts make retry unsafe. Before any tool dispatch, its identity and authorization must already have a durable owner; after dispatch, interruption yields settled/unknown outcome and cannot authorize rerun. Reconstruct after restart by the same ledger. Do not adopt ZCode speculative streaming as an implicit feature of a context refactor.

**Acceptance:** fail before first visible delta, after text, after accepted call, after dispatch, after result flush and after model-response commit; observe finite physical attempts and zero duplicate effects. Scope actual interfaces/IDs to the execution plan, but name ownership now.

### 3. Prevent recursive compaction of an oversized summary request (P1)

**Current evidence:** §5 protects the summary call with common admission and an eight-physical-summary-call limit. It does not explicitly say what happens when preparing the summarizer source itself returns “reduce”. Calling the same engine recursively can reacquire its transaction/lease, summarize the wrong active snapshot, reset counters, or replace the common assessor with an escape hatch.

**Add:** common admission is a common assessor, not permission for unbounded recursive orchestration. A summary request has an explicit purpose/source and finite preflight plan. If too large, use bounded source chunking/hierarchical reduction/offload under that transaction's shared allowance, or return an explicit blocked reason. Chunk summaries remain low-authority derived data with complete source/omission coverage; no local slicing may silently drop the very history being summarized. All final candidates still require full target-request reassessment. Choosing exact chunk sizes belongs to R0/policy fixtures.

**Acceptance:** oversized summarizer source, oversized indivisible block, exhausted call allowance and summary-of-summary must terminate without recursive publication or loss of protected data.

### 4. Specify branch/epoch disposition for durable child deliveries (P2)

**Current evidence:** snapshot has branch/binding epoch; result admission/claim has `(parentSessionId, taskId, resultRevision, deliveryKind)` dedupe; compaction preserves accepted suffixes. R4 does not explicitly cover a child settling after its parent rewinds or changes task branch.

**Add:** result durability and context promotion are distinct. Preserve the settled result regardless of parent branch. Record its spawning lineage and explicit delivery disposition for the current parent context epoch: promote, defer, already claimed, or incompatible pending review according to existing authorization. Rewind must neither erase a durable result nor turn old branch work into fresh authority for a different task. A context rebuild is not a fresh claim. Wake checks current lease/Stop/epoch again.

**Acceptance:** rewind before/after result admission/claim and crash at each boundary; durable result remains retrievable, no duplicate logical delivery/effects, no unacknowledged injection into incompatible context.

## Deliberate non-adoption is correct

Do not treat these exclusions as missing coverage: Codex private V2 compaction/metadata soft caps; DSH pre-pending-input pressure and fail-open spill; ZCode post-measurement schema/reminder drift or speculative tool execution without a ledger; PI's dual heuristics/fixed image guesses; OpenCode V2 text-only retained tail, incomplete length-stop rejection and legacy blanket-413 classification. The design explicitly improves on these weaknesses rather than copying them.

The proposal does not need exact ratios, a universal output cap, guaranteed provider-token accuracy, a new database, or an across-project event-driven rewrite to be a complete architecture. It does need the above contracts, traceability and integrated decomposition of the overlapping owners. The original blanket pause on all large-file decomposition in spec §10/reassessment §8 should be narrowed by root's current user-authorized scope; unrelated decomposition remains outside this review.

## Resolution review — 2026-10-15 documentation revision

Reviewed only the new `context-engine-framework.md`, `2026-10-15-context-decomposition-overlap.md`, referenced census/script and the small integration/status addenda. No product audit, provider calls, tests, builds, Git mutations or documentation edits. **No remaining material inconsistency found in this revision.** This is design-stage closure, not implementation approval.

| Earlier closure item | Revised contract | Assessment |
| --- | --- | --- |
| Dependency/effect ownership | Framework §§3–4 defines an acyclic target import direction, type-only summary contract dependency, composition-root injection, six narrow ports and separate lease/writer, attempt, tool, artifact and delivery owners. The engine cannot import implementation owners or instantiate a second compaction engine. | Addressed. No new circular ownership is required by the proposed graph; actual package surfaces/import checks remain execution gates. |
| Physical attempts and stream acceptance | §5 defines stable logical action and physical-attempt lineage, shared finite generation allowance/deadline, separate bounded provider-count allowance, SDK retry integration/disablement, conservative unknown reservations after restart and durable accepted calls before dispatch. | Addressed. Speculative streamed tool execution is explicitly excluded from this redesign. F09 covers the relevant failure cuts. |
| Oversized summary source recursion | §6 limits reductions to the existing transaction and shared allowance, requires coverage/omission lineage, forbids intermediate publication/reacquiring a session lease and requires final target-model reassessment. | Addressed. No recursive orchestrator or per-level reset is permitted; irreducible input may block. |
| Child result across branch/epoch changes | §7 separates durable result from promotion, retains spawning lineage, names disposition states, preserves the original logical admission key and rechecks fence/Stop/epoch at wake. | Addressed. Rebuilding a context is not a new claim, and incompatible/deferred results remain observable. |

Counting independently recomputed from the supplied census: original **43 files**, **27 reviewed across 19 tasks**, **16 pending across 13 tasks**. Full overlap is **6 tasks/9 files** (S20/21/22/23/25/28); partial **5 tasks/5 files** (S24/27/29/30/31); independent **2 tasks/2 files** (S26/32). These partition the pending 16/13 without overlap. Reused completed scope is **17 original files/10 tasks**, not additional completions. CX1 is **337 lines/function 256** and CX2 **457/function 278**; both remain outside the original denominator. Only completing/reviewing the full nine original files would move **27/43 to 36/43**. Partial work and CX completion cannot do so.

The temporary and published census copies have identical SHA-256 (`D339FCD82E2EA285E0CFA33ACE0DAAD99165FCE70A2A3F863B50F856F133A982`); their summary records **891 product files**, **18 current flags**, including **2 extra paths**, at `1b605d0e`. The script's selection/status/threshold logic supports that interpretation; it was inspected, not rerun. Dimensions and task membership in the overlap map match the census.

The old plan/spec/map addenda correctly preserve historical baselines and pending status while narrowing the pause to unrelated work. The main spec links the normative supplement and integrated decomposition; the research addendum preserves its historical evidence receipt. No design-only change is presented as runtime completion or release qualification. Concrete interfaces, policy fixtures and import/state-machine gates are explicitly required before each implementation unit; another reference re-audit is unnecessary for this closure.
