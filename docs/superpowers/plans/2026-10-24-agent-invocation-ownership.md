# Agent invocation ownership implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans. Implement this bounded packet, then return its full range for independent review.

**Goal:** A second direct invocation cannot replace or close the first invocation's fact/source/generation capabilities, and live host dependencies retain their documented receivers.

**Architecture:** One Agent owns one active mutation invocation through its final settlement. Reject a competing direct invocation before creating an action or changing ports; real service queues and steering remain their existing owners. Keep host dependency reads live while internal execution ports remain private.

**Tech stack:** TypeScript, existing managed/nondurable Session owners, Vitest, pnpm/Node on Windows.

**Spec:** `docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md`. Source/evidence diagnosis: `.superpowers/v0113-integrated-delivery-20261023/agent-baseline-triage.md`.

## Global constraints

- Product `0.1.13-rc.1`, Session format 12. No version/schema/history/seed changes, release, remote push or pure decomposition.
- Preserve accepted R5 failed-attempt settlement, current input freshness, original action/deadline/allowance and protected unresolved effects. Do not force overlapping candidates through admission.
- One writer/runtime in the assigned native-transfer worktree; GPT-6-Astra, no recursive agents. IC-C owns compaction/selection/reduction; W2 owns settings/Gateway watcher. Neither is part of this packet.
- Controlled fixtures only, no live accounts/providers/profile. Package-CWD tests, sequential per checkout, maxWorkers=2/minWorkers=1. Preserve failed/setup receipts and bind final source bytes to evidence.
- MAIN is root-owned. Full BASE..HEAD independent review before integration; no baseline failure waivers or unrelated green-making edits.

## Rulings and compatibility

**A01:** `run`, `runAdmitted`, `followup` and `compact` share a single invocation lease. A competing call rejects with stable `AGENT_BUSY` before `beginAction`, input claim, hook, transport, source registration or lifecycle factory. It does not queue, abort or mutate the active invocation. The lease lasts through all owned close/drain/flush outcomes, including failure. This replaces the README's obsolete overlapping-mutation promise; same-Agent overlap cannot preserve a coherent single Session request source. Cost: direct API callers must use their existing queue or await settlement. Actual service/SDK queue and active steering must remain usable; no second scheduler is introduced.

**A02:** Keep documented original dependency getter/method receivers and live model/effort/output/prompt surface reads. Getter order may include required fact-owner validation before effects; the old exact read-order array is not authority to delay that validation. Dynamic surface changes invalidate/rebuild through existing rules, never legitimize a stale transport. Fixed construction identities (Session, owner, session ID, initialization limits) remain captured as such. A caller cannot swap the Agent's owned Session by replacing a property.

**A03:** Do not snapshot all host data descriptors or bind all internals to a cloned dependency object. Use a small explicit private execution overlay/facade that forwards host reads to the original receiver and stores only Agent-owned ports locally. Prefer existing interfaces and ordinary descriptors; no universal dependency framework, global registry or serialized capability. Callback binding must retain nested objects' own receivers and not invoke getters eagerly. The controlled summary fixture must likewise not accidentally detach the supplied original dependency receiver; dedicated contract tests should use the actual exported `createAgent` directly.

**A04:** Fact setup failures must release the invocation lease and settle/finish any actually created resources in original order. Never overwrite an earlier error with a cleanup error or silently abandon a registered drain. A fact owner that remains unresolved is not bypassed merely because the busy lease has ended.

## Task 1 — Direct invocation exclusion and stable source lifetime

**Files:** `packages/core-agent/src/agent/create.ts`; narrow invocation helper in the same folder only if cohesive; `agent/types.ts`, `README.md`; `test/agent.test.ts`; new `test/agent-invocation.test.ts`. Existing source helpers may be read, not broadened without a concrete need.

**Interfaces:** Existing Agent signatures remain; competing Promise calls reject with `code: 'AGENT_BUSY'`. `updateContext` keeps its busy guard. `contextBudget` remains a pure read. Existing FactOwner/SettlementFacts APIs unchanged.

- [ ] Reproduce at current BASE: first invocation held during real acceptance flush, second invocation rejected by protection, first then fails through the replaced source. Immediately attach handlers to both promises and release holds in `finally`; distinguish product failure from old fixture's unhandled rejection.
- [ ] Add paired controls for held provider, acceptance flush, final stop hook, failed-turn drain and manual compaction. Exercise run/runAdmitted/followup/compact competitors. Count beginAction/lifecycle/source calls and actual sends, compare exact source identities and retained events before/after rejection. Rejected competitor must not consume input or append another turn.
- [ ] Implement synchronous acquisition before any new action/ports. End the lease only after original settlement finishes; failure/Stop/setup-throw paths join/finish originals exactly once. A following invocation after clean completion works; unresolved managed recovery still refuses through its existing owner.
- [ ] Replace obsolete overlap tests with explicit busy refusal plus sequential cumulative step telemetry/followup assertions, retaining truncated/refused/error, stop and flush controls. No longer await a second provider that is intentionally never entered. Test caller promises remain joined on every branch.
- [ ] Prove normal host/service serialized submissions and existing steer delivery during tool waiting remain their existing behavior. Use focused existing tests; do not modify production scheduling.

## Task 2 — Preserve original dependency receivers and live surfaces

**Files:** same construction owner; optional small `agent/dependencies.ts`; `test/fixtures/agent.ts`; `test/owned-budget.test.ts`, `test/context-recovery.test.ts` only direct dependency controls; README/type comments where contract changed.

- [ ] Before edits capture actual exported createAgent receiver/model-swap failure without the summary fixture. Add original getter `this`, callback `this`, nested model/step-input receivers, data-property replacement and getter-backed surface changes; no eager callback execution.
- [ ] Implement host forwarding/private execution ports. Session/owner/construction identity cannot drift. Frozen/read-only host objects work and receive no assigned fact/generation fields. Two separate Agents over distinct owners sharing a host dependency source cannot overwrite each other's execution ports.
- [ ] Correct summary fixture without mutating caller input or hiding compatibility failures. Retain optional prepare/custom-client behavior and existing concrete summary factory semantics; compaction eligibility/source policy is reserved to IC-C.
- [ ] Held retry with changed prompt, output, effort or model becomes stale through existing currentness checks; no second stale send or fresh allowance. Same value from unchanged source remains valid. Status reads cannot prepare or send.
- [ ] Prove updateContext and supported getter-backed host binding behavior still work after the invocation ends. Do not change admission/history to satisfy old getter order.

## Qualification, self-review and delivery

- [ ] Run focused causal RED/GREEN first. At stable source run the core-agent whole suite, affected session-executor serialized/steering controls and owner typechecks once. Compare exact names to R5's 35 failures; remaining recovery/Stop/compaction/fixture issues are honest later obligations. No broad rerun without changed source or concrete doubt.
- [ ] Preserve final actual physical source hashes, Git blobs, commands/exits and logs. Report any known unrelated failures and newly exposed failures individually. Do not sum overlapping test scopes.
- [ ] Review setup failure cleanup, pending source drains, nested receivers, pure budget reads and no-host-mutation. Commit only owned files, write task-1-report.md in this packet's SDD directory, then stop product writing for independent full-range review.

## Root self-review and collision table

| Pair / task | Produced vs consumed contract | Resolution |
|---|---|---|
| Task1 / Task2 | Same createAgent private ports and invocation lifetime | One implementer, sequential changes, one full-range review |
| Agent / IC-C | Runtime compactor still called through unchanged deps/context | Compaction files, eligibility and selection remain IC-C-owned |
| Agent / W2 | Settings changes feed live host getters | No shared product files; retain original receiver and stale guard |
| Agent / later recovery Stop | Exclusive invocation stabilizes original source ownership | Recovery/exchange/response settlement changes follow this packet |
| Agent / IC-B | Stable original sources and live dependency semantics | IC-B draft cannot overwrite these files concurrently; rebase after review |
| Task1 internal | Busy before effects vs existing overlap fixtures | Explicit A01 contract correction, preserve host queue/steering tests |
| Task2 internal | Live host values vs fixed owned Session | A02/A03 distinguish forwarded preferences from captured identities |
