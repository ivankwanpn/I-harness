# Agent contract regression qualification

> **For agentic workers:** Use executing-plans or subagent-driven-development for this one bounded test-owner packet; independent review follows.

**Goal:** Make ten known Agent regressions test the current documented ownership contracts and execute their previously unreachable safety assertions.

**Architecture:** Correct fixture assumptions only where existing product contracts and actual evidence prove they are obsolete. Keep actual provider/body/Stop/currentness behavior under test; report newly exposed defects instead of weakening assertions.

**Tech stack:** TypeScript, Vitest, actual local prepared adapters and Session owners.

**Spec:** Integrated delivery spec2026-10-23; source/evidence triage `.superpowers/v0113-integrated-delivery-20261023/agent-baseline-triage.md` families C/F/H; accepted Agent invocation plan2026-10-24.

## Constraints and scope

- Only `packages/core-agent/test/deep-context-request.test.ts`, `reasoning-streaming.test.ts`, `context-effect-freshness.test.ts` and a cohesive test helper if genuinely necessary. No product change, test skip, timeout increase, synthetic authority or fabricated model limit.
- Product0.1.13-rc.1/Session12 unchanged. Tests are not a decomposition task. Original R5/P1 failure receipts remain; no baseline waivers.
- Recovery/response/Stop settlement ownership belongs to P2; compaction/currentness belongs to IC-C; do not edit either. If a new product defect appears, preserve its exact failing evidence and tell root.
- Synthetic fixtures/local HTTP only, no live profiles/accounts. Sequential package-CWD runtime with maxWorkers2/minWorkers1. Join all promises and close actual owned resources; no global sleeps/polling until pass.

## Task 1 — Correct assumptions and reach the actual downstream assertions

- [ ] Reproduce the ten current failures on this packet's exactBASE. Inspect each actual assertion and current source, not just triage prose. Save source identity/commands/exits/raw receipts.
- [ ] Deep request five cases: composed AbortSignal is intentionally a distinct signal. Assert real caller cancellation propagation/reason, no new send/effect after Stop and joined settlement rather than reference equality. Retain depths2000/6000, shallow/deep schemas, exact nested arguments/results, actual controlled HTTP serializedbody/outputcap and same-session followup. Neutral stream-only custom ModelClient stays supported with honestly unavailable/unknown assessment; never force it to 'fit' by inventing capacity. The prepared HTTP path still must prove real fit/cap.
- [ ] Reasoning three cases: bind first delta atSeq/stream identity to its actual original block/event boundary rather than absolute historical index4. Retain first-immediate observation, offsets/order, batching, persisted fullblock and retry identity. Cancellation assertion should inspect actual cancellation classification and preserve reason where the owned signal carries it; do not accept arbitrary save/settlement errors as cancellation. Prove no late progress/timer after Stop and original prefix retention.
- [ ] Effect freshness two cases: actual contradictory dispatch after a never-dispatched result creates an unknown outcome and unresolved unit. Assert that stronger state, exact protected identities and actual candidate currentness refusal, including zero transport/replacement; do not alter product state derivation to restore old closed expectation.
- [ ] If downstream assertions now expose another mismatch, distinguish valid fixture contract correction from actual product failure using source and bounded controls. No broad matcher weakening, removal of core behavior assertions, fake completed effects or swallowed errors. Root decides any new product owner.
- [ ] Run all three corrected files and owner typecheck after source stabilizes. WholeAgent suite is unnecessary for test-only changes unless a shared helper changes, in which case name impacted scopes. Compare final same-file names/outcomes to exactBASE, preserving every rawfailediteration.
- [ ] Commit owned tests locally, deliver fullBASE..HEAD plus source/Gitbinding and command/exit index to this packet SDD task-1-report.md, then stop writing for fresh independent review.

## Root self-review

| Boundary | Decision |
|---|---|
| Three fixture families | Independent files, one coherent contractqualification owner; retain full downstream safety assertions |
| P2 semantic error/Stop source | No recovery/snapshot/agentabort fixtures or product files in this packet |
| IC-C reduction/current guard | Read existing contracts only; preserve protected-unknown refusal, no edit to selection/history |
| Optional custom clients vs strict summary | Ordinary neutral request remains compatible/unknown; no summary eligibility weakening |
| Source and test evidence | Reproduce actual failed assertions and carry real remaining failures; no import-error RED or false green from removed assertions |
