# ContextEngine F4 — physical-attempt ownership decisions

2026-10-16. Future implementation decisions, not code or passing evidence. Source pin `292362992f304e6bf7811f22df29608999c59539`; F1 remains the only product writer. Read-only inventory: `.tmp/context-redesign-20261015/r3-f4-attempt-preflight.md`. This consumes the approved [framework](../superpowers/specs/2026-10-15-context-engine-framework.md), [F3 bridge decisions](2026-10-16-context-engine-r3-f3-preflight.md) and prior sequence rulings, including the60-minute main-action override. Actual F1/F2/F3 APIs and next format are rebased before executable dispatch. Product0.1.13-rc.1/original27of43 and historical failed whole qualification stay unchanged.

## Actual scope and transport boundary

The existing producers are main/normal child, recovery, summary, both guardian review modes and title. There is also an actual nonstream generation path outside ModelClient: `media/read_video` → executor/gateway analyzer → `provider-runtime/runtime/media.ts` → `video-audio.ts:requestVideoAudio`, which POSTs Chat audio input. Include it. Provider catalog/auth HTTP is not generation; no active generation WebSocket/fallback or provider-count consumer was found at this pin. Do not construct those speculative paths to satisfy an inventory example.

The current synchronous B2 confirmation is attribution, not reservation. OpenAI subscription confirms before `systemFetch` awaits proxy selection/dispatcher creation, and Bedrock confirms before the SDK resolves credentials/signs/sends. A top-level counter or synchronous callback cannot durably debit before these requests and also check the final current owner afterwards.

Ruling: every IH-managed generation uses an **awaited durable reservation followed by one synchronous final issue check**, at the last IH-controlled handoff to its actual network transport. Preserve B2 execution identity/usage attribution as separate facts. Do not hold the document allocation/storage lane across auth, proxy, SDK, model or backoff waits. Subscription's per-request hook runs after proxy/dispatcher awaits and cannot be masked as a retryable proxy error. Bedrock's grant is checked by the actual SDK request handler after credential/signing work; explicitly disable SDK generation retry so seam retries each require another reservation. Qualify the installed pinned SDK with a recording handler, not only a mocked `send` method.

Ruling: managed generation uses redirect refusal (`redirect:'error'`) at fetch leaves. One invocation cannot silently follow a307 to make another generation POST. This deliberately requires configured endpoints to be final endpoints. Subscription/audio already refuse redirects; apply and test the same managed guarantee for API-key leaves. Do not change catalog/auth requests or invent a redirect-follow owner. A fetch handoff is an issuance boundary, not proof of provider receipt or billing.

Opaque injected transports or legacy stream-only clients that cannot expose an enforceable physical-send boundary cannot claim managed physical accounting. Preserve explicitly nondurable standalone support; refuse the managed bounded path before network with a typed capability error. Forward the same host-owned opaque grant through prepared originals/derivatives, maps, stable runtime handles, waiting/retry and usage wrappers; no payload boolean, serialized callback, duplicate debit or second ledger. Compose caller/action/transport signals so a control override cannot remove the fixed deadline.

## Actual retry policy, action start and immutable binding

Ruling: freeze effective retry policy from the **actual client builder/resolved wrapper**, not the settings default. Normal r5 gives original lane6 plus one changed-input lane6 plus summary sublimit8, total20. No retry wrapper means r0, total10 with main lanes1/1. Always affects eligibility but is still finite, using default finite r*=5 unless an explicit finite policy is supplied. A distinct summary client's retry policy cannot enlarge the parent's summary8 or total allowance. Approval/title derive their separate limits from their selected client.

The exact pure totals remain:

```text
main total G = 2 * (r + 1) + 8
original main lane <= r + 1
changed-input main lane <= r + 1; transition <= 1
summary physical sends <= 8 and also debit G
approval/title auxiliary total <= r + 1
media-analysis auxiliary total = 1; no retries
```

Validate safe-integer arithmetic. An explicit finite per-action cap can lower the derived cap. Active policy updates may constrain remaining work but cannot raise/reset its frozen allowance. Larger settings on a rebind, new prepared IDs, cap derivatives, source rebuilds or summary pieces cannot mint another pool.

Deadline accounting begins before resolver/admission work. There is a real asynchronous gap before the actual client's retry policy is known, so do not secretly restart the clock after resolving it. The executable event contract must represent a durable origin/start/expiry **before** resolution and a once-only policy bind before the first reservation. A pending-unbound action authorizes zero sends. This may use separate action-open/action-bind facts in the existing log; it is not a new ledger store. A crash between them preserves the original expiry/origin and cannot obtain a fresh action by calling the resolver again.

Main/recovery/summary use the named configurable60-minute default action ceiling. Approval's existing90000ms is a default: preserve a valid explicit existing reviewer timeout, including a longer one, rather than silently clamp user configuration. This clarifies older planning wording that called90s a ceiling; a finite configured value remains bounded. Start it before both isolated resolver and child spawn. Title keeps the host's configured timeout (Gateway8s today); absent timeout uses named30000ms default. Media retains its existing90000ms ceiling and any earlier tool/caller deadline. Earlier applicable action/caller bounds always win. Freeze narrow executor option names/default mapping in the executable plan; this phase does not add a new settings UI.

Use monotonic elapsed time live; persist the fixed expiry and last trusted clock facts without refreshing on reopen. Detectably backward/invalid restored timing blocks automatic continuation. Do not claim an infallible wall-time bound through undetectable system-clock/reboot changes; finite physical allowances still apply. Already-issued storage/effect/result facts settle after expiry.

## Fresh response and auxiliary origins

Only the existing input/executor owner creates a response action from a fresh durable input or one valid accepted-predecessor continuation with required results settled. Re-entering admit/run, retrying, policy changes, provider failure, login epoch changes and observation events are not fresh origins. Resume a recognized pending action with its remaining allowance/expiry; old ambiguous histories without accounting facts cannot certify free automatic retries. Later explicit human input is a separate origin through F1's existing action fence.

An accepted response followed by slow but genuinely settled tools may later form its one legitimate next response action while the turn remains authorized. The prior action's expiry does not authorize that transition; its accepted predecessor/results and current turn fence do. An unaccepted expired action cannot use this route. This keeps per-response bounds from becoming an accidental permanent session stop or a retry-renewal loophole.

Auxiliary grants have their own bounded spend and trusted origin:

- Approval uses the exact committed pending call/parent action, carried outside tool args. The current GuardianRequest omits call identity; add the narrow trusted carrier. Isolated and child reviewer consume one approval action across all retry/child steps/summary/recovery. A transient reviewer Agent cannot obtain normal main G20 pools. Preserve no-tools and fail-closed/human-fallback semantics. Keep its durable action in the origin document so child teardown does not erase spend.
- Title uses its exact eligible source input/parent action. Calling the helper twice for the same origin cannot mint two grants. Existing deterministic fallback is allowed without another generation.
- **Media-analysis is ratified as an actual additional purpose**, one generation/no retry/90s. Its origin names the committed read_video call/dispatch and parent action. Open before credential resolution; Stop during decode/auth/reservation prevents the audio POST. An already-issued request/result settles honestly. Failure cannot redispatch read_video or enlarge parent allowance. Preserve existing explicit audio-model selection and unsupported/unconfigured/partial-outcome semantics.

Normal task children retain independent document/action owners. Do not copy a parent's spend/expiry/lease or usage anchor as a child's authority. Auxiliary origins deduplicate through the existing document/history owner, not a disposable helper-local Map.

## Durable facts, rebind and unknown outcomes

F4 adds non-ignorable scalar action-open/bind/phase/close and attempt-reserved/settled/rebind facts through F1's one writer and core-session's one history transition. Exact names/schema and the next incompatible format need reviewed predecessor rebase; likely8 follows F2's7, but no number is activated by this note. Persist origin, fixed time/limits, cause/lane/parent, exact selected request identities and reservation identity/ordinal. Do not persist raw bodies, credentials, native signatures or per-message hashes. Derived counters can be rebuilt; no sidecar ledger/raw history.

A reservation must commit before physical issuance. Reserved with no trustworthy disposition consumes allowance after crash. Unknown storage quarantines continuation; lack of a B2 receipt or first delta is never proof of no send. A private final transport guard can prove unsent before network handoff. Only then may a bounded no-send rebuild retain the same reservation, durably binding its new candidate and invalidating the old issue capability. Never refresh an ordinal by recreating the grant. Generic fetch/SDK failure after handoff is conservatively issued/unknown, even if no bytes arrive.

The existing changed-input recovery fact and the action phase transition must agree through one managed group/owner. Candidate change alone is not recovery progress. Acceptance links to the actual reservation/confirmation, preserving B2 lineage. Seed/fork/import cannot copy operational authority; strict readers preserve audit facts only where safe or remap via the approved seed contract, never create new granted spend from old events. Old histories remain readable without fabricated accounting.

Owner errors (exhausted, closed, expired, uncertain, unsupported capability, stale grant) are terminal scalar-safe control outcomes. They cannot become provider TIMEOUT/TRANSPORT and be retried under always mode. Waiting guards must distinguish pre-send debit/uncertain storage from a silent provider stream: a stalled reservation cannot be abandoned and replaced while it might still commit. Retain late disposition through the original owner. Usage-store/cleanup failure after send adds zero generations.

## Required independent qualification

- Literal network counts: r5 original6+summary8+recovery6=20;21 denied. Explicit cap9 permits original6+summary3 and rejects another summary despite spare sublimit. Summary physical9 is refused inside one logical piece. r0 lanes1/1 and always finite controls prove no hidden defaults.
- Crash cuts before receipt, after reserved/before send, after handoff, after output/before acceptance, after accepted dispatch and result persistence. Preserve conservative debit and assert zero duplicated effects. Proven-unsent rebind permits one issue of the new candidate and zero for the old capability.
- Pause subscription proxy/dispatcher and real SDK credential/signing work; revoke owner/Stop/deadline; then release and observe zero underlying service requests. A retryable AWS service response produces one handler call per seam reservation with SDK retries disabled. A307 cannot add a generation POST.
- Exercise real maps/derivatives/runtime rebuilds/usage/project attribution and all actual producers. Two guardians modes stay in one auxiliary grant; CLI/default and Gateway/configured title deadlines differ as intended; read_video→actual analyzer with fake network issues exactly once for one committed dispatch. Same-origin helper re-entry does not create another grant.
- Cold resume before and after policy binding preserves start/expiry; accepted predecessor/results versus failed retry have distinct fresh-action outcomes. All summary pieces share expiry. Backward/invalid clock and pending unknown reservations block automatic sends while already-real settlement still drains.

Fresh copied Gateway/CLI execution and source hashes must cover the actual amended leaves, not just successful construction. No live provider, provider billing, token-count endpoint or global policy qualification follows from these controlled tests. E must include the newly identified media purpose in its actual-call inventory or explicitly report it unconverted; the narrow direct audio body requires an honest media projection/preparation contract, not an assertion that ordinary text tokens price its24MiB WAV allowance.

This connected gate can retain F3's named legacy admission math. It cannot be declared done with an unused AttemptLeasePort, an outer stream counter, a partial retry-wrapper patch, or uncontrolled injected SDK retries. The source/format/consumer and structural gates remain pending implementation and fresh review.
