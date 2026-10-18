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
