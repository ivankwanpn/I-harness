# S1 schedule deadline driver implementation plan

> **Execution:** Use executing-plans or subagent-driven-development. Root authorizes Tasks1–2 as one cohesive driver packet in an isolated checkout. Task3's assembly hunk remains reserved until the concurrent P2 writer finishes and root explicitly releases it.

**Goal:** Replace the library driver's healthy interval with one owned nearest-deadline timer while preserving shipping step-bound reminder delivery.
**Architecture:** Keep one driver, one schedule fold, the existing host acceptance seam and original occurrence identities. Background mode is opt-in via `start()`; the shipping assembly continues explicit `tick()` only.
**Tech:** TypeScript, existing core-session subscriptions/managed facts, Vitest fake timers and real managed JSONL host qualification.
**Authority:** `docs/superpowers/plans/2026-10-23-v0.1.13-integrated-delivery.md` Task 6 S1; `docs/research/v0.1.13-integrated-20261023/event-rebase.md` S1; adjacent brief.

## Global constraints / root rulings
- Product0.1.13-rc.1/Session12 unchanged; no schema/version/remote release, pure decomposition, new model wake, mail/Webhook or new durable store. All workers/reviewers GPT-6.1Sol until changed by user; no recursive agents.
- One writer/runtime in its assigned checkout; package-CWD tests sequential with maxWorkers2/minWorkers1. Preserve raw failed/setup evidence and final source/Git binding. No live profiles/accounts/providers. Do not broaden to P2, IC-B or unrelated surfaces.
- S1-01: no automatic retry for a failed unchanged background source/ambiguous host handoff. Manual tick, explicit retry/new start, or real source progression can reconsider it. Shipping remains manual pre-step, preserving its next-step retry behavior. State the library compatibility change; no hidden polling timer.
- S1-02: mutation adapters return idempotent disposers. Stop fences synchronously; failed known unsubscribe retains the same handle for an explicit retry and blocks restart meanwhile. Close shares a concurrent attempt, memoizes success only, and permits retry of failed cleanup after joining accepted work. A subscribe exception with no returned handle cannot be claimed cleaned; require atomic acquisition/rollback by the adapter and keep that driver fenced rather than reacquiring blindly.
- Existing small driver remains one cohesive owner; a focused helper is allowed only if required by the new lifecycle behavior, not to claim decomposition credit. Tests/scripts are not decomposition targets.

## Evidence and compatibility freeze
- `packages/schedule/src/driver.ts`: `start()` awaits `tick()` then creates a 30s interval; repeated start leaks intervals, stop during the await can rearm, overlapping ticks are skipped assuming another poll.
- `packages/session-executor/src/assembly.ts:999-1035`: only `tick()` at `agent/pre-step`; never start this driver or add mutation-driven admission here. Idle remains no model wake/no delivery.
- Assembly passes `session.events.slice(session.header?.seedLength ?? 0)` and commits through `action.facts.inputs.scheduled(dispatchEvents, admitted)`. Preserve that grouped managed commit, signal/action ownership, provenance, framing and visibility.
- Existing driver header/assembly comments describing old write-behind flush acceptance are stale against current managed tests: unknown publication remains private until exact reconciliation and owned reopen. Correct comments only inside owned hunks; never replay an uncertain managed batch.
- `index.ts:438-494`: one decision per session per explicit tick; earliest due one-shot wins, ties use create order; otherwise all overdue every records form ONE batch, latest anchored occurrences and shared decision `acceptedAt`.
- Keep one-shot input ID `${record.id}@${occurrenceAt}` and every-batch ID `schedule-batch@${acceptedAt}` exactly; no new ID, occurrence ledger, durable acknowledgement, event format or generic scheduler registry.
- `tools.ts` uses `metadataFactsFor(...).admit` for create/delete, is deliberately not concurrency-safe, and owns only the suffix. No tool mutation callback is needed or added.
- Real notification is imported `subscribe(sessionView, listener)` (`core-session/src/events/subscription.ts`), returning synchronous unsubscribe; there is no `Session.subscribe` method. It observes live publication, not a durable acknowledgement.
- Child risk is real: subagent `child.ts:24`/`followup/resident.ts:42` mount below `parentCtx`; core-plugin `scope/listeners.ts:98` bubbles; core-agent `agent/turn.ts:61` emits `{session, sessionId, signal}`. Current parent schedule listener accepts child emissions and can use a child's signal to deliver the parent's reminder.

## Files, dependencies and collision map
| Owner | Files | Dependency/reservation |
|---|---|---|
| S1 library writer | `packages/schedule/src/driver.ts`, `packages/schedule/test/driver.test.ts` | No P2 Agent/Session/coordinator changes; existing `index.ts` decision/fold/identity stays authoritative. Public driver types already export via `@i-harness/schedule/driver`. |
| S1 compatibility review | `packages/schedule/src/{index,tools}.ts`, existing schedule tests | Read-only unless a proven necessary comment/type correction is approved within S1; no decomposition or new module required. |
| Reserved host qualification writer | `packages/session-executor/src/assembly.ts` schedule pre-step hunk; `packages/session-executor/test/schedule-delivery.test.ts` | After library review and root's explicit hunk reservation against P2/R4B/D2/L1. Only exact-session filter plus qualification; no new background start or broad assembly/UI changes. |
| Root integration | Existing Task 6 / event-rebase evidence ledger | Record exact base, final source and evidence. CLI/Gateway wiring is deferred; no background-start shipping consumer exists today. |

## Contract to implement before consumer changes
```ts
// Additional options, beside unchanged sessions/events/deliver/now/logWarn:
subscribeMutations?: (changed: (sessionId?: string) => void) => (() => void)
pollMs?: number // deprecated source compatibility only; accepted/ignored, NEVER a polling/retry period
// ScheduleDriver additions; retain existing methods/result fields:
invalidate(reason?: 'mutation' | 'clock' | 'resume' | 'retry', sessionId?: string): void
close(): Promise<void>
```
- `start():Promise<ScheduleTickResult>`: idempotent per running generation; concurrent calls share its initial pass/result, with no repeated subscription/timer. Subscribe before initial snapshot. Stop/start during an older held delivery waits for that pass to settle before the new generation's initial pass, never adopting an empty overlap result as startup completion. Failed subscribe returns a reported result and terminally fences restart; the adapter must acquire atomically or clean up before throwing because no disposer was returned.
- `tick():Promise<ScheduleTickResult>`: still usable before start/after reusable stop; exactly one decision per enumerated session. Concurrent tick keeps existing immediate empty-result compatibility, marks snapshot dirty and never delivers concurrently. A stopped/manual tick creates NO timer or autonomous follow-up delivery.
- `invalidate(...)`: stopped => mark dirty only; running => coalesce a fresh snapshot/rearm request, never parallel delivery. Mutation argument scopes which failed source is reconsidered; omitted session means full set. `clock`/`resume` recompute from current wall clock, and `retry` explicitly permits one failed-state retry.
- `stop():void`: synchronously fence generation, set stopped, clear timer, detach subscription once; no subsequent delivery admission from already queued work or an in-flight pass. A delivery already handed to host may settle; check generation before EACH later handoff and rearm. A later explicit tick/start is deliberate reuse.
- `close():Promise<void>`: terminal, shares the current attempt and memoizes success; calls stop and joins accepted in-flight delivery/pass, rejects recorded unsubscribe failure after joining. A later close retries the retained idempotent disposer, never recreates it. Closed tick/start reject; invalidate is inert. Stop cleanup failure blocks restart until that original known handle is disposed; an unknown subscribe-acquisition failure stays fenced.
- Factory has no subscription/timer until start. Manual tick does not subscribe. A caller owns its actual source adapter; for a future started managed host use `subscribe(view, ev => { if (ev.type === 'schedule/change') changed(id) })`, plus membership-change invalidation for enumerated sessions.
- No shipping mutation adapter is installed: publishing a schedule must not create another model-admission path outside the existing pre-step policy.

## Task 1 — RED lifecycle/deadline controls, then minimal driver implementation
- [ ] Add fake-timer tests to `test/driver.test.ts`, first observe targeted RED with `pnpm --filter @i-harness/schedule exec vitest run test/driver.test.ts`.
- [ ] Assert empty start => zero timers; future targets => exactly one timeout at minimum target across sessions; earlier create replaces it; deletion removes/repositions it; stopped mutation never delivers. Assert supplied `pollMs:1` never produces a successful-state interval or affects nearest deadline.
- [ ] Hold initial deliver; concurrent start/tick/mutations, then stop/restart/close. Assert one admitted handoff, no post-stop later-session handoff, no late rearm, old callback cannot affect new generation, subscribe-before-first-events, one successful unsubscribe and zero listener growth. Include first disposer failure/second success, shared concurrent close, blocked reacquisition until cleanup and no timer after terminal close.
- [ ] Add a snapshot generation/dirty flag and one in-flight pass. After any await, reread invalidated/current source before deciding the next deadline; dirty catch-up recomputes state but never repeats an already handed-off unchanged decision in that pass. Bound each pass to its captured session list and one final snapshot/rearm, never `while(dirty)` inside one pass. Manual tick never drains a second decision from its own session.
- [ ] Running background mode re-drives remaining overdue decisions via its next one-shot callback only after verifying actual fold progress; one-shot precedence and one-every-batch-per-decision remain intact. A burst of mutations coalesces; the final mutation cannot be lost behind deliver's await.
- [ ] Arm with `setTimeout(callback, min(max(0, target - now()), 2_147_483_647))`, unref when available, fencing generation in callback and after every await. At the platform cap only reread/rearm the still-future real deadline; no global periodic clock check or empty timer.
- [ ] Backward-clock test: expiry reevaluates wall time and rearms remaining delay without early delivery. Forward/resume test: explicit `invalidate('clock'|'resume')` immediately recomputes due state; test targets beyond timeout cap, exhausted every record and cold restart over accepted dispatches.

## Task 2 — RED failure/no-progress controls, then bounded failure behavior
- [ ] Throw separately from `sessions()`, `events(id)`, fold/decide, `deliver`, and `logWarn`; assert tick/start promises settle, in-flight flag resets, errors are observable and unaffected sessions continue. Enumeration failure is driver-scoped (`<driver>:` error); event/fold/delivery failures are session-prefixed.
- [ ] Guard warning callbacks; a warning throw must not escape or recursively warn. Catch timer work promises so no unhandled rejection occurs. Catch failed enumeration without creating a zero-delay rearm.
- [ ] Freeze failed-state behavior: no automatic failure retry timer. Suppression key is session plus ordered active-record tuples `(id,kind,prompt,scheduledAt,afterSeconds?,everySeconds?)`; remove suppression only for a different tuple set or explicit `retry`/manual tick/new start, not merely a notification. Unrelated healthy deadlines continue. Enumeration/read failures await explicit invalidation/manual retry. This is visible degraded behavior, not delivery success.
- [ ] After successful deliver, reread the actual owned fold and verify every handed-off due record was removed or advanced past its handed-off occurrence; mere unrelated appended event is insufficient. If unchanged, report `delivery did not advance schedule state`, suppress automatic redelivery of that state, never append synthetic dispatch/ack. Handoff counts retain existing returned-deliver semantics and do not assert durability.
- [ ] Test a host returning success with no append, returning success with only unrelated events, rejecting after real committed advancement, and repeated unchanged mutation notifications. Bound attempts per explicit trigger; forbid infinite catch-up, microtask spin and zero-delay retry loops. A different session must still deliver.
- [ ] Test dirty create/delete during a held deliver and its own dispatch notification; fresh deadline must reflect final state, with no duplicate original occurrence. Retry/restart reads current log before handoff; unknown publication/reconciliation authority stays wholly in managed facts.
- [ ] Run targeted driver suite GREEN, existing schedule suite and `pnpm --filter @i-harness/schedule typecheck`; retain actual RED/GREEN output and exact file identity. Do not claim host acceptance from array-appending factory fixtures.

## Task 3 — reserved minimal shipping qualification
- [ ] In actual managed-host suite, reproduce child-scope `agent/pre-step` bubbling with overdue parent reminder: zero parent dispatch/admission/model request on child event, then one parent delivery on its own step. Run RED before the one schedule-handler change.
- [ ] Narrow unknown payload safely, require `payload.session === session` before reading its signal or ticking (session object identity is authoritative; matching/forged sessionId alone is insufficient). Return undefined on both paths, preserving waterfall payload; use the original own-step signal only.
- [ ] Retain/add main managed journal tests: idle creates zero schedule delivery and no model request; own boundary grouped dispatch+admitted adjacent batch; next-step claim and pumped second turn visibility; seedLength prefix exclusion and own suffix; all overdue every records share acceptedAt/batch inputId.
- [ ] Cold reopen the actual coordinator document: accepted occurrence does not repeat, overdue remainder delivers once; preserve existing unknown-publication privacy, exact reconciliation and owned reopen case. No raw array append may impersonate a managed durable acceptance.
- [ ] Run `pnpm --filter @i-harness/session-executor exec vitest run test/schedule-delivery.test.ts`, then package typecheck and affected child control identified by reserved owner; preserve setup-invalid/baseline failures as such. Root reviews the narrow hunk against current P2 before integration.

## Acceptance and honest limits
- [ ] Root review verifies no healthy interval/fallback/second registry; only real-deadline timeout and no automatic failure retry. Manual step-bound contract, original keys, grouped facts, own suffix and existing reminder rendering remain unchanged.
- A wall-clock jump cannot be observed before a supplied clock/resume notification or outstanding timer fires; an empty driver cannot detect clock changes itself. This packet adds no platform power monitor or periodic probe.
- Source callbacks are synchronous; thrown failures settle as above. An arbitrarily never-settling host deliver cannot be made finite or durably classified by this driver; stop fences further admission immediately, close joins the outstanding host promise without inventing success or replay.
- This qualifies an opt-in library deadline facility and existing shipping step-bound consumer. It does not establish shipping idle deadline delivery, external cron, automatic model wake, all CLI/Gateway callers, full Task 6 or release completion. Record these exact limits in scoped acceptance.

## Root self-review / shared-file reservation
| Boundary | Resolution |
|---|---|
| Task1/2 driver lifecycle, error suppression and timer | One implementer/full-range review; source progression and actual due decision remain authoritative |
| Driver start vs shipping tick | Explicit library background mode only; no new host start/mutation admission, idle model remains quiet |
| Failure state vs new deadline | No zero-delay loop or success-derived acknowledgement; source tuple/current fold controls reconsideration |
| Stop/close vs source callbacks | Original idempotent unsubscribe retained on failure; no reacquisition or late callback effect |
| Task3 assembly vs P2 generation sites | Task3 is NOT authorized in initial packet; root releases exact schedule hook after P2 source freeze |
| Clock/resume | Only explicit invalidation or actual outstanding deadline detects changes; no healthy clock polling |

Initial delivery writes task-1-report.md to this plan's root SDD directory, exactBASE..HEAD/commands/exits/final source bindings and outstanding Task3. Commit owned driver/tests only and stop for fresh independent Sol review. Do not mark full S1 or whole Task6 complete from Tasks1–2.
