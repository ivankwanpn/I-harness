# R3 F4 — durable ownership at physical generation boundaries

> **For agentic workers:** Use the established subagent-driven-development workflow, one fresh GPT6.1Sol implementer and independent task reviewer. Complete the connected Task1 before advancing; root resolves routine design issues.

> Rebased on accepted C3 product e6d7d7b03b4d0d4118550ecb2182ae9fa8b8ec8f, including both independently approved capture/provenance corrections. Exact F4 BASE is the following documentation checkpoint, recorded in the task ledger before dispatch. The user already approved the complete redesign.

**Goal:** Every IH-managed generation, including physical retries, summary pieces and auxiliary requests, spends one finite durable allowance immediately before the last IH-controlled transport handoff. Reopening, repreparing or changing a client cannot renew it. All supported protocols retain their own wire/auth/validation behavior.

**Architecture:** Extend the existing core-session history transition and F1 managed document, with an executor generation-lifecycle facade and narrow opaque seam capability. The existing document journal is the sole durable store. Actual main/child/manual/guardian/title/media callers supply trusted origins; adapters enforce issue. B2 confirmation remains attribution; C3 preparation remains side-effect free; R2E admission policy stays separate.

**Tech Stack:** TypeScript ESM workspace; existing Node, pnpm/Vitest, core-session/F1 JSONL owner, fetch transports, installed AWS SDK3.1123.0, existing Gateway/CLI build scripts.

**Spec:** docs/superpowers/specs/2026-10-15-context-engine-redesign.md; docs/superpowers/specs/2026-10-15-context-engine-framework.md; docs/superpowers/specs/2026-10-15-context-engine-r1-contracts.md. The two tracked F4 preflights below freeze the already approved specific transport and auxiliary decisions.

**Inputs:** Approved redesign/framework/R1 contracts; tracked 2026-10-16-context-engine-r3-f4-preflight.md and 2026-10-18-context-engine-r3-f4-transport-rebase.md; accepted C1/C2/C3 reports and failed receipts. Later reviewed source corrections supersede earlier pins. The installed-SDK probe establishes a technique only, not implemented F4 guarantees.

## Global Constraints

- One product writer; GPT6.1Sol/high implementer/reviewer, no recursive agents. Root coordinates, reads evidence and resolves design questions; root does not repair product code.
- Product remains 0.1.13-rc.1. Unrelated decomposition remains 27/43. No installed account/profile, live provider, release, new third-party dependency, reachability reseed/allowlist, fake consumer or speculative transport.
- Preserve protocol-specific lowering, raw-option precedence, model binding, native reasoning/signatures/namespaces, cache semantics and accepted usage. This phase changes generation authorization/accounting, not token/admission formulas or provider billing claims.
- One core history transition and one F1 document writer. No parallel raw log, sidecar spend store, filtered/copied Session, helper-local authority cache or inherited operational grant. Derived indexes may be rebuilt from the existing log.
- Keep dependency direction acyclic. Core-session defines persisted scalar contracts without importing seam/adapter/executor runtime; persistence consumes those contracts/F1, not model clients. Seam owns transport capability propagation, while executor composition supplies actual generation lifecycle ownership. ContextEngine remains independent of concrete transports and execution owners.
- A summary/checkpoint/candidate/telemetry receipt is never main-send permission. Durable reservation is separate from B2 attribution and capacity. Pending-unbound, uncertain, exhausted, expired, stopped and unsupported managed capabilities permit zero new physical sends.
- All actual generation callers are in scope: main, normal children, changed-input recovery, automatic/manual summaries, isolated/child guardians, title and read_video audio analysis. Catalog/auth traffic is excluded. No active generation WebSocket or provider-count route exists to implement.
- New cohesive functions at most120 lines; ordinary production leaves normally150–400 lines, shorter contracts/helpers allowed. Extract touched orchestration/retry responsibilities instead of enlarging assembly, turn, seam index or managed-document closures. Tests/tooling are exempt.
- Meaningful RED precedes behavior changes. Preserve failed receipts, strict assertions and behavior coverage. Focused iteration then affected complete scopes once; no timeout inflation, repeat-until-green or fabricated packaging/network proof.
- F4 is one connected gate. Partial schema/port/wrapper work is not completion. R2E/R4/R5/R6 and named existing qualification failures remain subsequent obligations.

## Frozen execution contract

### Identity and origins

An ephemeral F1 ManagedAction, step ID, B2 sendId or prepared request ID is not an allowance. Open a durable generation action with exact trusted origin, fixed start/expiry and purpose before asynchronous model resolution/source preparation. Pending-unbound allows zero sends. The final selected main preparation supplies the once-only effective policy binding before any summary transport; a distinct summary preparation cannot enlarge that pool.

Fresh main origins are a newly committed actionable input, or one accepted predecessor whose required dispatch/result obligations are settled while the current turn remains authorized. Normal root/child Agents use their own document owner. Plugin feedback, telemetry, another step ID, failed request, rebind, recovery marker or helper reentry alone cannot create an action. A recognized open action resumes remaining allowance/expiry. Ambiguous old actions without accounting facts cannot get free automatic retries; old conversation/history stays readable and later explicit input can form a fresh origin through the existing input owner.

The generation deadline does not become the entire turn/tool deadline. After accepted model output, already-authorized tools and their required settlement continue under existing tool/turn controls; a slow settled tool may legitimately precede the one next response action even after the prior generation action expired. Required result obligations mean that accepted response's actual tool/code dispatch-result contract, not every unrelated background job in the session. Explicit user Stop and loss of the existing turn/document authority retain their normal semantics. Do not replace the turn signal with an expired generation signal or cancel unrelated work.

Auxiliary origins deduplicate at the durable origin owner:

- Approval refers to an actual committed tool/call OR code/call and parent generation action. Both modes consume one parent-document-owned allowance, including transient child steps/summary/recovery. The reviewer child cannot mint normal main pools, copy spend as local authority or erase spend on teardown. Cross-document refs are audit data; only the borrowed opaque capability permits issue.
- Title refers to its exact eligible committed input/parent origin. Repeated helpers reuse the action; deterministic fallback adds no generation.
- Media refers to actual committed read_video tool/code dispatch and parent origin. Carry it outside model arguments/output. Start before decode/auth; repeated analyzer calls cannot mint another allowance or redispatch the tool.
- Explicit manual compact has an independent summary-only origin: durable command/run identity and action-open before preparation. Reentry/uncertain write retains that identity. A later explicit API/UI operation may be new through the actual caller boundary. No main lane or implicit main send follows publication.

Only the generation owner creates/resumes capabilities. Scalar IDs copied from another document cannot grant authority. Committed identity is not current ownership.

Approval/media commonly begin after their parent model action has completed acceptance. Validate that real accepted-parent/call lineage plus the still-authorized tool/turn/document source; do not require the parent's generation pool to remain open/unexpired or spend it again. Title may precede the first main action: its committed eligible input is sufficient causal origin without fabricating a parent main action. Each auxiliary retains its own finite bound, deduplication and earlier caller cancellation.

### Numeric policy and time

Derive r from the actual final prepared client composition: absent retry wrapper means0; normal uses finite maxRetries; always stays eligible but is bounded by finite r=5 unless an explicitly supported finite policy supplies another value. Validate safe integers and safe arithmetic.

| Action | Physical allowance |
| --- | --- |
| Main / normal child | total G=2*(r+1)+8; original lane<=r+1; changed-input lane<=r+1; one recovery transition; summary lane<=8 and also debits G |
| Manual compact | summary-only total8 across pieces, merge, quality and wrapper retries |
| Approval / title | total r+1 from actual selected prepared client; all operations share it |
| Media | one physical generation, no retry |

Named Agent/executor options: modelActionTimeoutMs default3,600,000; modelActionMaxAttempts optional positive safe integer lowering the derived cap. Propagate through real normal-child/composition carriers; no settings UI. A larger option does not increase the derived cap. Rebind/settings can constrain, never raise a frozen allowance or renew expiry.

Approval preserves existing reviewer timeoutMs default90,000, including valid explicitly longer values. Title preserves actual timeoutMs (Gateway8,000), default30,000 only if absent. Media90,000 and earlier caller bounds remain. Start before resolver/spawn/decode. All summary pieces/retries share original expiry.

Live elapsed time is monotonic. Persist original wall start/expiry and last trusted time on real lifecycle facts, without polling writes. Cold continuation never refreshes expiry; invalid/detectably backward restored time blocks automatic issue. Do not claim detection of every clock/reboot change. Already-issued facts/results may settle after expiry/Stop.

Known-unsent rebind is at most3 per action and obeys stricter existing limits (such as one auth-epoch rebuild). Persist each rebind: same ordinal, frozen allowance/expiry, new candidate binding, old capability invalidated. Only the original transport owner's live proof of no handoff permits it. After crash that private proof is absent; missing output/confirmation is never proof.

### Durable facts and validation

Actual predecessor is format7; F4 activates format8 before new operational events. Newer-format refusal precedes repair/append. Supported old formats upgrade via the existing owner; never invent historical attempt records.

Use closed version1 context/action and context/attempt families within existing validation/fold. Scalar DTO spelling may follow conventions; mandatory relationships:

- action-open fixes document/action identity, closed purpose/origin reference and original start/expiry;
- once-only bind fixes effective retry descriptor and total/lane limits;
- at most one changed-input phase, atomic with the existing real context/recovery transition;
- monotone close/disposition, never reopening/replenishing;
- reservation fixes unique action ordinal/ID, purpose/lane/cause, owner incarnation and exact final semantic/payload identity (or honestly bounded supported media identity);
- unsent rebind retains reservation and increments a bounded counter while replacing exact candidate;
- terminal closed disposition distinguishes unsent/issued/unknown/completed/failed; reserve alone stays spent after crash;
- accepted linkage ties actual committed model acceptance to action/reservation/B2 confirmation in the same managed transaction. Preserve closed v2 attribution; prefer a paired new typed fact over silently extending v2.

Reserved-but-unissued or foreign-owner/lane requests cannot certify model acceptance. Summaries/auxiliaries settle honestly without fabricated main exchange acceptance. Full append, staged groups and cold reload validate structural expected type/seq/owner/order. Reject prototype/accessor/extra-key/sparse/unsafe scalar/foreign-ref DTOs. No body, credential, native signature or per-message hash vector in records/errors.

Seed/fork/import cannot copy operational spend/expiry/incarnation or accepted links as fresh authority. Extend explicit refusal; do not rely on an unknown-event fallback. Normal children start independent action history. Preserve archive/reader semantics.

New action/attempt bookkeeping is not model source, conversation progress or a projection rewrite. Its append cannot by itself invalidate a source-equivalent private summary, retire accepted calibration, make a new eligible exchange or reset compaction cooldown/breaker. Actual changed input/accepted output still follows the existing semantic transition. Test this with the real C3 source/proof and B2 observation owners, not a fabricated stable hash.

### Awaited debit and final issue

One awaited receipt commits a conservative debit. Then one opaque request capability synchronously checks current owner/incarnation, action/expiry/Stop, exact candidate/source, lane and single use immediately before transport. This is separate from synchronous B2 confirmation; no hidden async I/O in that callback.

Auth/proxy/dispatcher/SDK credential-signing/storage waits hold no document allocation lock. Final check follows all these awaits. Ordinary current-input/B2 checks occur before marking handoff so rejection proves unsent. Mark issued immediately before invoking transport; even synchronous transport throw is conservatively handed-off/unknown. Later status storage cannot refund/replay. Preserve original registered disposition/reconciliation; no automatic retryAbsent to allocate a replacement attempt.

Every actual wrapper retry reaches one new reservation from the same action, not wrapper-plus-leaf double debit. Derivatives/maps/stable clients/usage capture retain the same grant identity. Conflicting carriers refuse. Snapshotting cannot clone it into data; never put it in headers/body/wire fields. Intersect caller/action/wait signals so overrides cannot remove a deadline.

Owner failures are safe terminal outcomes, not provider TIMEOUT/TRANSPORT. Always eligibility cannot retry them. Pending storage cannot be abandoned as a silent-provider timeout while it may commit. Provider-liveness clocks begin/reset at actual issue; the action deadline covers pre-send waits. Late original disposition remains owned; no concurrent unobserved reservations.

Preserve existing retry eligibility/backoff/Retry-After behavior, including the user's required at-least10-second interval for Selected model is at capacity. The new allowance bounds sends; it does not shorten capacity backoff, reset waiting state through a wrapper reentry or treat ordinary HTTP400 as a recoverable context overflow.

### Actual leaves and prepared policy

- Responses public/subscription, Chat, Messages and Gemini use guarded final fetch. Managed generation sets redirect:error; catalog/auth unchanged. Configured endpoints must be final;307 cannot add an unreserved POST.
- Subscription passes a per-request guarded-generation hook through http-transport after proxy/dispatcher awaits. Proxy and adapter catch preserve trusted owner errors rather than redacting them into retryable transport failures.
- Bedrock uses installed real SDK RuntimeExtension/request-handler after credentials/signing, maxAttempts1. Forward handler lifecycle/config methods. Concurrent requests keep separate grants; a private options symbol may survive command handling and is stripped before delegation. No global current-request variable, transitive dependency edit or mocked-send-only proof.
- Opaque injected fetch/send/legacy clients cannot assert managed accounting without an explicit enforceable boundary. Refuse managed network; preserve explicitly nondurable standalone capability. Tests exercise the real boundary contract, not a self-certifying boolean.
- Effective retry descriptor is on the final prepared handle and all derivatives, so async runtime rebuild cannot bind stale outer policy. The original main preparation binds before summary; summary policy never expands parent allowance.
- Direct audio consumes the same physical contract through actual ToolExec/analyzer/runtime/POST. Identity/coverage is honest about audio; text-token pricing cannot certify the WAV allowance. R2E handles later media capacity policy.

## Task 1: Connect the durable owner to every producer and physical leaf

**Prerequisite:** C3 reviewed and exact accepted BASE recorded. Capture needed failing scope baselines before changes. Do not repeat unrelated historical suites merely to obtain newer totals.

**Files and responsibilities — rebase actual paths, no parallel owners:**

- core-session/src/events, conversation, managed, serialization: closed schema, single transition, exact groups/refs, readonly derived status, format8; cohesive action/attempt leaves.
- session-persistence/src/coordinator, format and actual JSONL/remap/fork owners: captures/receipts, required settlement/reconcile, cached/header upgrade, cold validation, authority refusal.
- session-executor/src/lifecycle plus actual assembly/service/child carriers: generation facade over F1, trusted origins and named config; extract touched assembly responsibilities.
- core-agent/src/agent turn/admission/recovery/execution/finalization/create and context-reduction bridge: early open, final policy bind, shared grant, recovery group, accepted link, manual path; extract response orchestration instead of expanding nested turn loop.
- compaction/src/summary and real factory: borrowed action across all pieces/quality/retries, no second counter owner.
- llm-seam/src/prepared, waiting guard, provider errors/retry composition: opaque contract/policy, signals, timing and terminal outcomes; extract touched retry implementation/config from oversized index.
- provider/src/clients/build, provider-runtime/src/selection/binding and stable executor/Gateway usage/model wrappers: final effective policy and identical grant.
- Actual llm-openai/openai-compatible/anthropic/gemini/bedrock and http-transport leaves: final guard, redirects/errors/SDK handler.
- core-tools prepare/ToolExec, Code Mode broker, both guard-approval modes, session-title, provider-runtime media and actual executor/Gateway analyzers: outside-args origins, fixed deadlines, no helper renewal.
- Actual CLI/SDK/Gateway callers, type fixtures and contract READMEs. No new UI/CLI feature. Read-only observation sends nothing.

**Interface invariants:** Existing ManagedAction/FactOutcome/CapturedActionFact remain the publication boundary, PreparedModelRequest remains the actual frozen candidate and B2 ExecutionConfirmation remains separate. Add a closed immutable effective policy descriptor to actual prepared handles and an opaque generation control to PreparedStreamControl/LLMRequest. The adapter consumes a reserve→issue capability; it cannot create the action, choose its limit or replenish it. The runtime owner consumes final prepared facts plus F1 ports and returns that capability, not an exposed mutable counter. Optional injected clients lacking this enforceable transport contract are explicitly unsupported for managed generation. No new interface gets an export without a real consumer.

**Focused test placement:**

- New packages/core-session/test/generation-history.test.ts: literal closed transitions, invalid refs, ordinal/phase/rebind bounds and format checks.
- New packages/session-persistence-jsonl/test/generation-reservations.test.ts: actual owner/backend receipt/unknown/Stop/cold cuts, extending existing fact-batch-journal.test.ts fixtures.
- New packages/session-executor/test/generation-actions.test.ts: real input/accepted/manual/child origins, slow tool crossing expiry, no duplicate effect.
- Extend packages/llm-seam/test/prepared-wrappers.test.ts, retrying-client.test.ts and waiting-guard.test.ts: actual frozen policy/carrier, literal transport counts and pending debit timing.
- New packages/llm-bedrock/test/physical-attempts.test.ts using the real installed SDK/recording handler; extend packages/http-transport/test/system-fetch.test.ts for both proxy awaits.
- Extend actual adapter retry-http tests, packages/guard-approval/test/guardian-review.test.ts, packages/session-title/test/managed-title-action.test.ts and packages/provider-runtime/test/video-audio.test.ts.
- New packages/desktop-gateway/test/generation-actions.test.ts for shipping host manual/main/retry/title and actual copied equivalents; preserve existing long-growth-host.test.ts hard-fit/calibration/cold oracles.

Use direct independent oracles in these tests, rather than deriving expectations from production constants. For a real recording transport's scalar trace, assert the literal sequence and counts:

~~~typescript
expect(networkCalls.map(call => call.lane)).toEqual([
  'main', 'main', 'main', 'main', 'main', 'main',
  'summary', 'summary', 'summary', 'summary',
  'summary', 'summary', 'summary', 'summary',
  'recovery', 'recovery', 'recovery', 'recovery', 'recovery', 'recovery',
])
expect(networkCalls).toHaveLength(20)
expect(afterDeniedNetworkCount).toBe(20)
expect(new Set(committedReservationIds).size).toBe(20)
~~~

The trace rows above are populated only inside the actual controlled fetch/SDK handler invoked by production; append/confirm callbacks are not network calls. After a held pre-send reservation or held SDK credential resolver is cancelled and released, assert both actual call count and real event suffix:

~~~typescript
expect(networkCalls).toHaveLength(0)
expect(toolExecutions).toBe(0)
expect(acceptedExchanges).toHaveLength(0)
expect(secondReservationWasCreated).toBe(false)
~~~

These are behavioral oracle fragments, not standalone test harness implementations: create the held Promises/backend through the existing owner/transport fixture APIs, and inspect actual journal/finalized results for the named variables. Test fixtures must not call private transition helpers instead of the production caller whose guarantee they assert.

Focused command pattern from the relevant package directory uses the already installed executable:

~~~powershell
node ../../node_modules/vitest/vitest.mjs run test/generation-actions.test.ts --maxWorkers=2 --minWorkers=1
~~~

Use the listed actual filename for each owner; record RED exit/assertion before product changes, then GREEN. Full owner scripts/types and packaging are recorded separately.

### Work sequence

- [ ] Read approved contracts and final C3 report; map origins/wrappers/handoffs, file boundaries and baseline identities. Raise concrete incompatibilities to root.
- [ ] Write failing closed-history/owner/count tests at the listed actual boundaries; run and retain the meaningful RED.
- [ ] Implement format8/fold/captured operations through F1 with settlement/cold cuts; rerun focused cases GREEN.
- [ ] Write physical leaf/policy/waiting regressions, observe RED, then connect controls and final handoff; assert independent calls after GREEN.
- [ ] Write actual origin/auxiliary/acceptance regressions, observe RED, then cut over every caller under the same owner; preserve source/B2 facts and effect assertions.
- [ ] Complete all required focused controls; affected full scopes/types once at stable source; classify every failure, then structure/audit and copied execution.
- [ ] Self-review and commit coherent product units without root documents; seal source/copy/evidence/report. Root dispatches fresh review and same-writer fixes.

### Required independent oracles

1. Literal network counts: r5 original6+summary8+recovery6=20,21st refused; total cap9 permits6+3 and denies next; summary9 denied inside one logical piece; r0 lanes1/1; always finite. Event/callback count alone is not the oracle.
2. Async policy change during preparation binds final descriptor once; later larger settings/client/cap derivatives cannot renew. Summary-before-main uses bound parent pool despite different client policy.
3. Crash cuts before reserve receipt, after reserve/before handoff, after handoff/before response, after output/before acceptance, after accepted dispatch/result. Cold spend conservative, effects never duplicated. Unknown storage quarantines; original late disposition retained.
4. Known-unsent rebind same ordinal, old capability0/new1, counter persists and fourth denied. Generic transport failure cannot claim unsent.
5. Final invalidation after storage/auth/proxy/SDK awaits causes0 sends. Pause subscription proxy and dispatcher separately, actual SDK credential/signing; Stop/revoke/expire then release.
6. Real installed AWS handler: concurrent A/B distinct grants; local retryable503 yields one handler call per seam reservation with SDK retry disabled; environment settings do not create hidden attempts; lifecycle/options forwarded/private grant stripped.
7. Managed307 no second POST. Opaque unsupported managed transport refuses before network; explicitly nondurable standalone remains.
8. Actual A/B/map/retry/wait/runtime/Gateway/usage chain preserves grant. Three physical sends exactly3 reservations. Usage attribution/storage failure adds0. Conflicting carriers/signal override cannot bypass.
9. Stalled reservation exceeds ordinary provider timeout without a new debit/send. Action expiry blocks; late storage reconciles. Owner failures terminal even in always.
    Existing capacity-retry timing remains at least10seconds, and ordinary400 remains terminal rather than authorizing changed-input recovery.
10. Accepted predecessor plus settled results versus unaccepted/expired/failed retry: only valid continuation or new input creates one next action. Hook/metadata/step alone creates none. Later human work remains possible.
    Include a real accepted tool whose settlement crosses the prior generation expiry: it is not replayed/cancelled by that expiry, and its valid continuation gets one new response action while the turn remains authorized.
11. Auto-summary and confirmed recovery share action and one phase. Manual command owns summary-only8, helper reentry cannot renew and publication sends no main; subsequent real input owns a new action.
12. Fresh/resident normal children own separate pools; parent spend/expiry/anchor never grants child authority. Cold seed/import cannot transport operational authority.
13. Both guardian modes share one parent-owned auxiliary allowance and pre-resolve/spawn timeout; child cannot mint normal pools. Include ordinary tool and Code Mode origins; preserve no-tools/fail-closed/human fallback and explicit longer timeout.
14. Actual CLI/default title30s versus Gateway8s/configured starts before resolve; same origin twice cannot mint another action; fallback/read adds0 sends.
15. read_video decoder→ToolExec→real analyzer/runtime→controlled audioPOST: one committed tool/code dispatch, one send, one final result. Stop during decode/auth/reserve0POST. Failure does not replay tool or renew; parent allowance independent.
16. Monotonic59:59→60:00 across pieces/backoff blocks same-action issue; earlier caller wins. Cold bound/unbound retains expiry; backward/invalid clock blocks continuation; issued settlements drain.
17. Full/staged/cold validation rejects duplicate/late bind, excessive ordinal/lane/phase/rebind, wrong refs/owners, unsafe scalar/getter/prototype/sparse DTO and invalid acceptance link without mutation. Old read/current7→8 upgrade and old-reader8 refusal precede repair.
    Real action/attempt-only appends leave source-equivalent C3 summaries and B2 calibration intact and do not count as accepted semantic progress.
18. Fresh copied Gateway/bundledCLI execute main/retry/reduction/Stop/read, plus copied child/manual/auxiliary/media controls where appropriate. Exact source hashes and independent underlying call counts; build/initialize alone insufficient.

### Verification discipline

Use actual package scripts/types, six-route corpus, reachability self-tests/gate and build/verify-dist. Read package names/config before commands. Full scopes cover changed core-session/persistence/JSONL/seam/adapters/transport/provider/runtime/coreAgent/compaction/executor/subagent/guardian/title/media/SDK/Gateway/CLI owners. Run low-worker suites sequentially. Test-only fixes need affected checks, not rebuilding identical product copies.

Never run recursive pnpm in an isolated BASE through a node_modules junction. Use explicit installed Node/tool entrypoints with immutable correct dependencies, recording BASE/tool hashes. Keep prior failed transport/dependency receipts. New network fixtures install deny-by-default before construction, with synthetic credentials and explicit fixture endpoints.

Report per-scope pass/fail/skip, changed-contract fixtures and exact failure disposition. Existing core/subagent/Gateway/raw-fork/CLI/F1-CLOSE-OBS-01/B2 observations are not blanket baselines or waived. Reuse sealed unchanged evidence; rerun only for changed dependencies or an unresolved concrete doubt. Overlapping counts are not additive.

Final report includes actual producer matrix; open/bind/reserve/issue/settle behavior; RED/GREEN/call counts; format/cold/Stop/auxiliary proofs; failure qualifications; actual copied paths with raw and canonical identities. Seal closed manifests, not actively changing reports. Warnings and unexecuted routes remain limits.

**After acceptance:** continue R2E, R4, R5 and R6. F4 alone is not release/full-redesign completion.

## Execution record

- C3 predecessor accepted:e6d7d7b0; fresh full review and original-reviewer scoped correction acceptance are retained.
- F4 BASE/writer/commits/evidence/review are recorded in the task-specific SDD ledger at dispatch and delivery.

## Ruling: existing persistent built-in test-mock execution

The explicit executor modelPolicy='test-mock' path is a real existing local cassette implementation, not a physical provider. Add a closed format8 local-invocation action op and accepted-link alternative; do not fabricate HTTP/SDK payload identities, physical attempt records or B2 send confirmations, and do not silently downgrade its managed document to nondurable.

Bind executionDomain once as physical or local-test. A local invocation conservatively spends the same finite purpose total/lane/deadline policy but is recorded separately from physical network attempts. A same-action domain change refuses; only a legitimate new origin can bind a new domain. Acceptance references its exact committed localInvocationId. Full/staged/cold/seed validation rejects wrong-domain, forged, mixed or inherited operational links. Local test counts cannot establish physical transport proof.

Require BOTH the actual llm-mock-owned WeakSet identity and explicit test-mock policy for the final selected/captured client. Stable handle rebind to another client cannot retain local bypass. Preserve capability only through trusted wrappers; no public arbitrary-client registration or model-supplied flag. Put cyclic built-in construction under the actual factory's ownership rather than blessing arbitrary wrappers. Keep ordinary managed opaque-client refusal intact.

Required controls: actual persistent built-in mock positive; arbitrary spoofed client negative; local-to-physical/opaque rebind negative; finite local allowance/cold preservation/Stop; exact accepted local link; actual network count0. These supplement, never replace, all6route/media physical oracles.

Reason: preserve truthful explicit local test support and existing persistent semantics. Cost: one closed local execution domain with its own validated fact/link shape; it grants no general provider bypass.

## Ruling: early input origin and once-only preparation

Actual service.startTurn resolved getOrCreate/model binding before inbox admission, and Desktop input additionally called assemblyFor/prepare before its admission. Use the existing receivedInputFor/writable document owner to commit exact raw input before any execution-time model resolution; no second inbox/log. Capture host start/expiry before the first preparation await, including admission/storage, and persist those original values. Queued-only receipt does not start a running action or resolve a model: open at authorized execution start. Preserve queue/steer ordering, cancellation and duplicate clientToken/inputId acknowledgement.

The selected model-visible representation is raw original human input plus separate derived observation, not transformed-only replacement. Raw admission text/images/provenance is promoted exactly once. Changed host/plugin preparation supplies complete derived text with lower-authority recorded-context framing, never another human request or hidden permission grant. Unchanged preparation adds no duplicate. Supplemental context is separate recorded context. Images remain with raw admission/imageInputId, not copied to derived text. This is a deliberate compatibility change from transformed-only wire representation, with semantic tests for retained original input/exact expansion once/no authority escalation.

A closed preparation identity links raw admission, preparation-start, complete prepared result and eventual promotion. Persist start before invoking transformPrompt/expandPluginPrompt; runCommand is not assumed pure. Dormant prepared results may precede claim but cannot be model-visible standalone user/message before original promotion. Atomically install raw promotion and derived observation/link through the existing input owner, or equivalently atomically promote a committed dormant result reference. Full/staged/cold/renderer semantics agree; no text-mismatch waiver, helper-only rewrite, repeated transformation or second claim.

Unknown started preparation without complete result is explicit blocked/failed input state, not permission to rerun effectful preparation or send raw slash input unexpanded. Stop/expiry/unknown publication prevents new model consumption. Known failure preserves received text and records scheduling disposition honestly; later explicit input remains possible. Do not fabricate historical raw input from an older transformed admission. Preserve existing ingress/storage bounds rather than introducing a new truncation policy.

Both real service and Desktop paths require held resolver/transform, duplicate token, queued-only/read0modelcalls, Stop before/after preparation, cold pending/complete/uncertain and exact raw/images/provenance/final-link controls, with0duplicate transforms/tools. Extract cohesive input-preparation/lifecycle modules; do not enlarge service closures. Cost: required causal ingress/promotion cutover for early clocks and truthful provenance. Broader R5 authority/UI audit remains separate; existing UI original input identity stays intact.

## Ruling: first response borrows the preopened ingress generation action

Keep the real ingress F1 action/source open over the same document writer through service-turn settlement. Carry its opaque preopened GenerationAction outside text/arguments through the actual runAdmitted/AgentInputOptions path; only the first response adopts it once. Validate exact document/incarnation, original input/promotion and current turn/controller. Scalar actionId, serialized options, another followup or a normal child cannot adopt it as authority.

Agent's existing F1 fact action may coexist over that same writer. Completing the first generation does not prematurely finish ingress source/drain or discard pending settlement. Its original monotonic start/expiry spans all admission/preparation/resolver/Agent awaits. Generation expiry does not abort the whole ingress turn or accepted tool work. Later response actions require accepted predecessor plus settled obligations under the live turn fence; only that legitimate transition gets a new clock. Bind original allowance from final prepared main policy before any summary, not from an earlier model snapshot.

This is scoped live-source composition, not a new ledger or duplicated durable owner. Verify borrowed-versus-owned teardown, once-only adoption, cross-owner/input rejection and held admission/resolve/Stop paths.

## Ruling: managed provenance must bind the actual owned terminal invocation

Managed execution structurally owns the complete generation terminal operation: reserve, final current/Stop/deadline check, issue, one HTTP/SDK handoff and settlement. Supported factory-name provenance alone is insufficient. Opaque provenance binds the exact immutable candidate and that owned terminal path. Generic createPreparedPayload with arbitrary execute callback remains standalone-only; a marker/boolean or mentioning reserve does not certify it. Managed custom prepare returning arbitrary/copied stream objects refuses before those streams execute.

Protocol encoding/auth/decoding remain adapter responsibilities. Factor their actual generation handoff into cohesive owned terminal paths; SDK ownership includes real client/handler composition, maxAttempts1 and the post-credential/signing boundary. Unknown runtime.send or injected fetch cannot be blessed as bounded. Preserve actual prepared evidence through trusted derivatives/wrappers only. Generic arbitrary wrap callbacks that can skip inner.stream do not automatically inherit managed provenance; narrow structured retry/wait/observation/mapping composition preserves the owned inner path. No public arbitrary-client/prepared registration escape hatch.

This is an IH API and actual supported-path guarantee, not an in-process hostile-code sandbox. Auth/decoder/observer callbacks retain their documented trusted/pure roles. No unrelated plugin API redesign or new general transport framework/dependency. Controlled installed-SDK handler fixtures report their observed handoff honestly and do not claim unknown handler internals, provider receipt or billing.

Required negative controls: custom prepare ignoring control; copied/forged exposed fields of a genuine handle; generic execute ignoring reserve; arbitrary callback wrapper skipping inner. Refused streams/transport callbacks issue0calls. Positive real adapters, cap derivatives, retry/wait/usage/runtime/Gateway carriers still reach exactly one bound terminal per reservation. Cost: actual seam/terminal composition refactor necessary for enforced bounded sends, not an outer counter convention.

## Ruling: private Bedrock terminal bridge preserves the dependency direction

Approve a narrowly package-private seam import/subpath consumed by the actual llm-bedrock terminal leaf. Concrete SDK/client/command construction stays in llm-bedrock; do not move it into neutral seam or add a transport package/registry. The actual adapter factory owns complete SDK/handler invocation and the private bridge binds its exact frozen prepared candidate/terminal. Arbitrary execute callbacks cannot request this certificate through supported public APIs.

No top-level barrel export, configurable register/brand API or provider-name switch blessing arbitrary callbacks. Generic prepared factories stay standalone-only. Record/check the specific built-in adapter consumer graph; no fake consumer, reachability baseline or allowlist workaround. Trusted wrappers preserve actual terminal identity, while copied/forged/custom handles refuse.

Package-private is a supported API/source-ownership boundary, not a sandbox against hostile in-process code importing internals or monkeypatching globals. This is the limited exception resolving the upper adapter/lower neutral seam dependency, with negative public/custom wrapper tests and real SDK post-signing/count/Stop proof retained. Cost: one documented internal bridge with an actual producer/consumer; no weaker owner check or invented physical guarantee.

## Ruling: delegated-input is a child-local execution origin

Add closed delegated-input origin for an actual NEW child-local initial agent/input/admitted record or committed subagent/inbox record. Keep inherited/observation provenance, without human stamping or isSubagent authority. Validate exact child document, own seed boundary and closed reference alternative (initial inputId/seq, or actual inbox identity/seq). Seed-imported history, copied scalar refs and an already consumed origin cannot mint another allowance. The actual launch/followup owner supplies an opaque source capability. First Agent response borrows the CHILD-owned action; parent counters/expiry never transfer. Parent-owned guardian auxiliary remains its explicit separate case.

For fresh children, retain existing pure role/feature/permission gates, then create document/new delegation admission/open before asynchronous declared-model resolution. Preserve selected model/window/effort, validateBeforeLaunch/publication and settlement fences. Failure/Stop after creation retains truthful failed state and releases live resources without replaying input or hiding durable history.

Resident rebuild/read alone creates0actions and performs0executable model resolution. Locate real pending initial/inbox work first, then open/resume its action and original clock before resolving. Pure metadata/role gating can remain early. The actual selected child binding/limits must be installed before preparation/summary; no provisional unknown-window send. Repeated wake/helper/cold reuse cannot renew the same origin; a genuinely new committed inbox message may form the next action under the live child fence.

Required controls include fresh declared-role held resolver/Stop, resident no-inbox lookup0resolve, same inbox repeat/cold spend, valid new inbox action, foreign/seed references and own child limits/parent calibration isolation. Root inspected the actual child.ts resolve-before-document and driveFollowups rebuild-before-pending paths. Cost: real child execution ordering changes; this does not complete R4 delivery/epoch qualification.

## Ruling: monotone constraints retain original scope and past facts

A main action's later lower constraint comes from its actual main-client policy or explicit action configuration. A different summary client's smaller retry setting only changes that wrapper's own eligibility; it neither raises nor silently shrinks parent-derived G/main lanes. Explicit lower action cap/deadline constrains all subordinate sends. An auxiliary binds/constrains from its own actual client.

Persist the lower constraint so later larger settings or cold reopen cannot restore allowance. When the lower ceiling is below spent count, historical reservations/settlements stay valid and future remaining is0; never refund or invalidate earlier facts. Derive a shorter duration from the original start, not current time plus duration. Already-issued dispositions remain recordable; a quota update alone is not user Stop or authority to discard real results. Verify lower→higher/cold and a low-retry summary client under a larger main pool.

Root also verified the one new workspace edge llm-seam→existing http-transport is acyclic at BASE (http-transport depends only on already pinned undici7.29.1). Keep lock/link changes scoped. Common imports/pure preparation must not perform proxy/auth/network work; those remain in actual terminal execution. Qualify actual build/runtime consumers of the changed seam export graph.

## Ruling: effectful human preparation is not a generic inbox transform

Only explicit fresh raw human ingress opts into host/plugin command preparation through its closed receipt/preparation provenance. System notification/schedule inputs and delegated observations stay literal recorded context, even when their text begins with a slash. Current service notifications use child-report/plugin observation and schedules use plugin observation; they are not human command invocations. Do not infer eligibility from text, a generic admittedInputId, or an upgraded format8 header.

Older already-prepared or ambiguous admissions cannot be transformed again. Their source history is preserved without inventing original raw text. Verify a genuine human slash-command positive and a slash-prefixed system/child-report0transform/0command-effect negative. Preserve existing actual wake/execution owner rules; this does not expand into the later R4 delivery gate.

## Ruling: a committed observation wake has its own closed execution origin

Allow observation-input only for an actual committed own-document system admission from session.notification (child-report/plugin observation) or session.schedule (plugin observation), naming exact inputId/admission sequence. Validate the closed combination, own suffix and actual wake/turn source; a producer string or copied scalar is not a capability. Keep observation authority and literal text, with zero host command preparation. A genuine idle wake need not fabricate an accepted model predecessor.

Same-admission duplicate, helper reentry and cold continuation reuse original action/expiry/remaining allowance or refuse a consumed origin. An observation merely consumed within an existing response/turn cannot independently create another pool or bypass required accepted-predecessor/result obligations. Only actual authorized wake-response execution opens this origin. Existing schedule driver timing stays unchanged; this is not a new idle timer or the later R4 delivery redesign.

Verify genuine system wake, slash-prefixed zero-transform, duplicate/cold no-renewal, foreign/seed/forged source refusal and active-turn observation controls. Reason: legitimate existing system executions must remain usable without upgrading their content to human authority. Cost if wrong: a missed ownership combination could either block an existing wake or renew allowance; direct source/consumer controls are mandatory.

## Ruling: seeded preparation content retains semantic linkage only

The existing seed owner may emit/remap a closed semantic derived-input link to the remapped raw user/message inside the same seed prefix. Do not import preparation lifecycle, generation actions, attempts or parent execution grants. Validate backward reference, seed boundary, inherited observation provenance and source/group consistency through full, staged, cold and candidate readers. This alternative is seed-prefix representation only; ordinary live ingress still requires the strict preparation result/promotion linkage.

Raw plus its derived observations remain one semantic/protection unit. If a raw source cannot be retained, dependent observations must be dropped with it or the seed refused; no orphan derived observation. Preserve visible text/source labels and images once without elevating inherited raw or derived authority. Actual seed/fork roundtrip, malformed/foreign/out-of-boundary controls and zero imported operational grants are required. Reason: stripping operational state must not destroy semantic grouping. Cost if wrong: the new link could become a live-promotion bypass or split protected input; closed placement and reader tests address that risk. Full R4 seed/ACL qualification remains separate.

## Ruling: approval-review children borrow a narrowly scoped parent auxiliary

The parent approval action opens before resolver/spawn and owns every physical debit. The actual guardian composition attaches one opaque shared-generation binding to the exact approval-review child document/incarnation, parent accepted call and current turn. A role string, parentActionId or generic generation-control brand is insufficient; foreign child/document/purpose/reuse refuses. Child main/summary/recovery all spend the same approval lane, total r+1 and fixed deadline. They cannot mint a normal main pool, refresh for recovery or acquire a separate summary pool.

Keep model exchange acceptance and B2 observations truthful in the child document. Do not append parent-owned action/acceptance facts there or pretend the parent reservation is child-local. Parent owns auxiliary settlement/close after actual review settlement. Normal child lifecycle remains independent. A cold child archive cannot reconstruct a parent's live grant. Preserve no-tools, model-deny versus malformed/operational failure, cancellation and existing human fallback. Exercise isolated and child modes, ordinary and Code Mode tool carriers, and foreign-child negatives.

Reason: an approval helper is one bounded parent operation even when implemented as a temporary Agent. Cost if wrong: generic shared-generation configuration could bypass normal child ownership or double count acceptance; the exact live owner binding and negative controls are required. This is not a general cross-session quota-borrowing API.

## Ruling: direct audio owns a specific non-prepared transport terminal

Use the narrow MediaGenerationAction for the actual read_video dispatch/current turn, opened before decode/auth. bindAudio fixes physical/off/media count1 without fabricating a PreparedModelRequest, token measurement or B2 HTTP confirmation. The actual requestVideoAudio terminal builds an immutable serialized body and private audio-json-body descriptor, awaits durable reservation, then synchronously checks current/Stop/deadline and issues one fixed global fetch followed by settlement of that same attempt. Managed redirects refuse; there is no hidden retry or generic injected execute callback certificate.

Descriptor/payload hashes are internal ownership data, not evidence of exact token pricing. Do not expose hashes, bodies or audio in diagnostics. Reentry of the same dispatch reuses/refuses its original action; only a genuinely new explicit authorized tool call can acquire a new action. Preserve decode/caller limits and earlier cancellation. Type-only core-tools to existing seam contracts is permitted with an acyclic graph; no runtime upward dependency or whole-Assembly carrier. R2E must retain honest audio measurement coverage.

Reason: this real generation path is not an ordinary text prepared request and still needs physical accounting. Cost if wrong: a generic audio bind could bless unrelated requests or conceal token uncertainty; constrain it to the actual terminal and controlled direct-send/Stop/deduplication tests.

## Ruling: yielded Code Mode work retains its actual cell lifetime

A still-live Code Mode cell may invoke its already-authorized tool work after code_exec yields or the parent Agent turn settles normally. The broker already creates a new exact-document F1 action/settlement source per invocation. Use that actual source plus the committed code/call, parentCallId and original opaque accepted code_exec lineage for auxiliary composition; do not reuse a finished parent F1 action or mint another main allowance.

Validate exact document/incarnation, real invocation and current cell/session/Stop owner. Approval opens before actual nested dispatch; media opens from the committed nested dispatch. Normal parent turn completion or expiry of the old main generation alone is not cancellation. Explicit Stop, cell termination, guest module completion, disposal or owner revocation prevents new auxiliary work, while already-issued settlements drain through their original sources. Existing abort signals must remain effective.

Keep lineage host-side, outside guest workerData and model arguments; it cannot be serialized, restored from an old archive, reparented to a new turn or replaced by scalar IDs. Only the narrow broker composition callback receives its real action; individual tools receive purpose-bound factories. Test actual yield then late guardian/media positive, plus Stop/terminated/foreign-source/same-invocation negatives.

Reason: background tool lifetime is already distinct from the parent model response lifetime. Cost if wrong: reusing an expired parent source blocks valid background work, while a loose callback could extend revoked execution. Exact existing cell ownership, not a new scheduler or R4 delivery mechanism, is the boundary.

## Ruling: pending human steer preparation shares the current response action

At the actual step boundary, prepare eligible pending steer inputs under the already-open main response action and its original deadline/allowance. No separate generation action is opened for those steer admissions. A steer can arrive before the first response (whose origin is input or an actual observation wake) as well as after an accepted predecessor; origin=predecessor alone is therefore neither necessary nor sufficient.

Use a closed explicit steer-preparation alternative naming the exact pending delivery=steer admission and bound to the actual current response/F1 owner. It requires the existing fresh human-host preparation policy. Initial ingress retains exact input-origin linkage; system, delegated and legacy observations stay literal. Persist preparation-start before effects, completed results remain dormant, and the existing input owner atomically claims raw input plus derived observations. Do not waive text equality or open a mid-retry transform path.

Refuse canceled/consumed/foreign admissions, closed/expired actions and repeated preparation. Cover first-response steer, accepted-predecessor steer, multiple pending steers sharing one action, actual source/fence negatives and cold/unknown no-rerun. Existing wait-only steer must release the parent's wait without aborting accepted Code Mode background work; explicit terminate/Stop still revokes that work.

Reason: actual startStep claims steers after main action creation, and late human guidance must preserve once-only preparation without refreshing the model budget. Cost if wrong: a narrow predecessor-only check rejects valid first-response steering, whereas a loose origin waiver could execute arbitrary observations or renew work.

## Ruling: input promotion uses its own guarded closed-family capture

Add a narrow ManagedAction input-promotion capture for the exact input-start and steer-claim groups, through the existing F1 beforeIssue boundary. Validate its closed fact family before generic dispatch; do not pass input data through the generation or reduction capture, introduce an unrestricted guard flag, or weaken C3 wrong-family/accessor refusal. Initial and prepared-steer promotion share the extracted preparation owner and actual input owner.

Stop/expiry observed before irreversible issue prevents promotion. A promotion already issued before that fence may settle afterward through its original capture/receipt; preserve the true result without new model permission or repeated preparation. Unknown publication keeps the same capture identity for reconciliation. Required preparation completion/failure settlement remains recordable after Stop/expiry.

Test held storage before versus after issue, wrong-family/accessor refusal with zero effects, no repeated transformation, and a usable later explicit input after refused old promotion. Reason: a check before an awaited unguarded input append leaves a late-claim race. Cost if wrong: a broad capture escape would let unrelated events bypass ownership, or a late result could be discarded/replayed; family-specific validation and the original issuance boundary are required.

## Ruling: detached imports cannot rewrite a live seed boundary through metadata

At the inspected coordinator, ordinary updateMeta serializes a header rewrite but does not atomically establish an empty-target seed import, check the managed cache, or refresh an existing managed header/index. Do not compose profile/read, updateMeta and open as an atomic seed operation. Never fabricate a parentSession for anonymous detached content or relabel an existing target suffix as inherited.

For F4, forward the actual detached source header into the seed compiler and preserve existing plain/empty detached imports. Semantic-only derived links require an empty target already created through the existing seed-aware owner with the exact compiler-sized prefix and truthful source lineage. Missing/mismatched metadata or a nonempty target refuses explicitly before new import writes. Exercise a valid predeclared target and missing/mismatched/nonempty/cold refusal with unchanged bytes and zero operational grants.

The convenient general semantic-import bootstrap, including joint header/seed crash handling, is assigned to the existing R4B semantic compiler gate before whole-framework completion. This is an explicit new-format compatibility limit of the intermediate F4 gate, not a claim that the final import feature is finished. Reason: a separate metadata rewrite would bypass the qualified document boundary. Cost if wrong: valid new-format detached imports may require the predeclared seed path until R4B; that remaining consumer obligation is recorded rather than hidden by weaker validation.

## Ruling: persisted incarnation names the actual document owner

Persist the actual F1 document owner incarnation on generation reservations. A fresh UUID per lifecycle is a different identity and must not be labelled document ownership. ManagedAction exposes readonly frozen sessionId/incarnation metadata supplied by the actual ManagedDocument.beginAction; it does not expose a HeldFactOwner capability, registrar or grant.

Real action identity, ownsAction, original captures/fences and private known-unsent proof remain mandatory. Recreating a lifecycle within the same document cannot reconstruct lost proof merely because scalar owner metadata matches. A managed path missing genuine owner metadata refuses; only explicit nondurable scopes may use a local identity with no crash-durability claim. Compare actual reservation metadata to the F1 receipt owner and cover document close/reopen.

The known-unsent rebind ceiling is TOTAL3 for the generation action, not3 for each reservation. Preserve stricter auth/source limits. Exercise rebinds spread across different reservations, the fourth refusal, same-ordinal spend and old-ticket invalidation. Reason: persisted ownership and global bounded rebinds are load-bearing contracts. Cost if wrong: a recreated helper could be mistaken for recovered authority or multiply the action's no-send rebuild allowance.

## Ruling: local test ownership includes the actual prepared handle

Managed local invocation must prove both the actual selected/captured factory-owned mock client and its exact genuine prepared source. Maintain a private mock prepared WeakMap, with readonly source traversal through existing trusted structured seam wrappers. Copied/replaced prepared streams, a custom prepare method attached to a genuine mock object, foreign mock owners and arbitrary callbacks that skip the inner stream do not inherit local eligibility. No public registrar, opt-out or fixture-name blessing.

The actual mock stream closes over its private preparation implementation rather than its mutable public prepare property. This preserves honest standalone public override behavior without recursive fallback. Persistent fixtures migrate to genuine owned local preparation or real controlled terminals, retaining their behavioral assertions. Cover trusted retry/map/wait/derivative positives and copied/foreign/replaced preparation, domain-switch and cold-limit negatives. Local invocation/acceptance facts remain distinct from physical provider proof.

Reason: factory ownership of the client alone does not authenticate a subsequently replaced prepared stream, and public-method dispatch caused the observed mock recursion. Cost if wrong: an overwritten method could bypass managed local accounting or recurse indefinitely; exact private source identity and actual wrapper controls are required.

## Ruling: reconciled input promotion carries its original turn-close obligation

The promotion helper may report an actual committed disposition through a narrow receipt callback. It identifies the original captured promotion group/turn-start and fires only from a genuine committed outcome, including same-capture reconciliation. The initial-turn caller records that actual opener before propagating the original run failure. This authorizes required closure only: no model continuation, input replay or new generation grant. Steer promotion has no turn-open callback.

When reconciliation remains unknown past the initial failure, retain the recoverable close obligation with its original source. Do not lose it because executeTurn returned, close a later unrelated opener, or synthesize an end for a start never committed. Existing ambiguity checks remain strict.

Test committed frame then reported-unknown, matching reconciliation, original run failure with model0, exactly one truthful turn/end and usable later explicit input; also still-unknown and Stop before/after issue. Reason: the prior local turnOpen flag was set only after helper success, so a reconciled real opener could be left unclosed. Cost if wrong: receipt loss could strand the session or a guessed opener could close another run; only the original committed receipt may drive that cleanup.

## Ruling: known-not-promoted steer cleanup retains the exact capture

A completed steer preparation may be canceled only after its exact retained input-promotion capture settles as not-issued or absent. An unknown result must reconcile first; issued, committed or still-unknown outcomes never authorize cancellation. Use a narrow known-not-promoted settlement callback driven by that capture, separate from the initial-turn committed-opener callback.

The preparation owner privately validates the exact returned completed-result identity and raw admission before using the existing received-input cancellation owner. If cancellation itself fails or remains unknown, retain its original owner/capture and cleanup obligation; do not duplicate cancellation or mark cleanup finished prematurely. Do not reuse completed preparation across generation actions or open a new model grant.

Cover completed transform then held steer promotion crossing expiry, zero original sends, no repeated transform and usable next explicit input. Also cover unknown-to-committed without cancellation and unknown-to-absent with truthful cleanup. Reason: C-F4-STEER-NOT-ISSUED-01 reproduced the old completed steer blocking a later input with GENERATION_UNCERTAIN. Cost if wrong: guessed cleanup could discard an already accepted input or repeat effects; only the original capture's known disposition may drive cancellation.

## Ruling: CLI early origin preserves the existing FIFO lane

The actual runHeadless host must capture wall/monotonic start before its first await, record the exact raw cli.prompt through the existing received-input owner, and open the actual initial executable generation before asynchronous runtime/profile/model resolution. Reuse the exact document and original source through assembly, runAdmitted and settlement. Literal CLI task text does not acquire human-host effectful transformation authority. Keep Stop and SIGINT/SIGTERM cleanup valid on early acquisition/resolution exits.

Current SessionExecutor.runAdmitted selects one exact input and can bypass FIFO. Do not target the newly appended CLI task ahead of recovered work. Select the actual oldest eligible pending input for initial preparation; open/borrow that input's original generation, then continue the existing serial lane. A fresh task queued behind older input remains receipt-only until its execution starts, with no second early pool. Recovered existing origins retain their original spent allowance/deadline and cold refusal rules. A failed predecessor stops this pump and leaves later inputs pending; it cannot silently launch the new task.

Extract cohesive CLI ingress/lifetime composition rather than expanding the large runHeadless body or adding another inbox/scheduler. Cover held actual runtime/model resolver with Stop and expiry, exact original clock, recovered FIFO, failure pausing the later task, literal input and zero duplicate admission/grants. Reason: the actual CLI resolved its model before document-bound initial execution, leaving a gap despite the direct Agent early-origin fix. Cost if wrong: per-ID pumping could reorder user input, or an eagerly opened queued task could get an incorrect deadline/extra pool; actual oldest-input selection and the existing lane own the order.
