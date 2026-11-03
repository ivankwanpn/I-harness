# Service regression contract qualification implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans for this one bounded test-only packet; fresh independent review follows.

**Goal:** Close two recorded service-test contract failures by verifying the current retained-result and real cancellation behavior without weakening the original user-visible assertions.
**Architecture:** Update only the existing service test owner to use actual result-envelope data and cancellation classification. Capture the real second model request and keep complete service queue/disposal/continuation checks; no product changes or fake capability.
**Tech Stack:** TypeScript, Vitest, real SessionService/filesystem/retention and controlled local models.
**Spec:** Integrated delivery Task7 known-obligation closure; P1/S2 historical failure evidence and accepted R4A result retention, P2/S2 source ownership.

## Constraints and exact ownership

- Only `packages/session-executor/test/service.test.ts` may change, plus a cohesive test helper only if root approves a demonstrated need. No production changes, test skips, broad matcher weakening, timeout increases, provider budgets, live profiles/providers or pure decomposition.
- IC-B owns service.ts/assembly/request/host code in a different checkout and explicitly excludes this test file. Do not change that worker's branch/source or cherry-pick its WIP. Root owns MAIN and will run a combined gate when both are ready.
- Preserve Product0.1.13-rc.1/Session12. GPT-6.1 Sol, no recursive agents, no remote/release actions. Use package-CWD Vitest maxWorkers2/minWorkers1; one runtime in the assigned checkout, no unrelated suite repetition.
- Historical P1 and S2 logs remain evidence, not waivers. Record an actual current BASE RED for both original test names before correcting assumptions. If newly reached assertions expose a real product defect, preserve it and return the exact owner issue to root instead of changing the assertion to fit it.

## Task1 — real error result and close cancellation

- [ ] Run the two unchanged cases on exact BASE using `pnpm exec vitest run test/service.test.ts -t 'M61: a failing fs tool|closeSession\(\) with a submit in flight' --maxWorkers=2 --minWorkers=1`; retain source copies/command/CWD/time/numericexit and actual failures. Inspect original current result-envelope and service cancellation owners before edits.
- [ ] M61 uses a real missing-file read in an owned temporary workspace. Assert the actual ResultEnvelope/retention branch and extract the small inline value through that documented schema (not arbitrary recursive error search). Its concrete `error` text and `code:ENOENT` must remain present. If the owner unexpectedly returns unavailable/missing/malformed retention, fail and report it; do not accept any branch as success.
- [ ] Preserve actual tool/call, matching tool/result, original call identity and turn/end. The original operation runs once, and the model reaches the recovered final answer. Strengthen model visibility by recording the actual second request passed to the controlled model; verify its real tool message contains the failure, not just a mutable archive inspection. Use a call-through controlled model over the existing script/prepare path, no synthesized result or transport success.
- [ ] The legacy `deriveMessages` assertion must respect its actual content representation, without dropping visibility checks or assuming String(object) is serialized model content. Assert exact relevant content/text blocks and the original final assistant answer. Join the real service before removing its workspace even if assertions fail; retain the original test name/intent.

```ts
expect(resultEnvelope.retention.kind).toBe('inline')
expect(resultEnvelope.retention.value).toMatchObject({code:'ENOENT',error:expect.any(String)})
expect(actualSecondRequest.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('ENOENT'))).toBe(true)
expect(originalToolCallCount).toBe(1)
expect(actualFinalAssistantText).toContain('recovered')
```

- [ ] The closeSession test's queue barrier can be before model execution. Preserve that timing and record actual cancellation/error outcome; do not replace it with a test that waits until a different phase. Check native AbortError classification and original signal reason when a model request exists, rather than exact legacy wording `agent aborted`. Do not accept an arbitrary saving/policy/error as cancellation merely because the submit rejected.
- [ ] Retain successful close, settled submit, no running/queued rows, removed selected assembly, released gated work and no unhandled rejection. If the model starts, its original signal must be aborted and it may not emit new work after the close boundary; if it has not started, release of the setup gate must not admit a new model afterward. A held controlled model/error identity may be observed through the existing fixture; do not fabricate a new signal/reason.
- [ ] Preserve positive service behavior: unaffected later sessions/reopen and original isolated-close controls remain covered by the existing same-file suite. Do not delete those tests or globally disable lifecycle/retention.
- [ ] Run the two cases GREEN, then the one whole service test file and owner typecheck on frozen sources. Compare same-file names/results to BASE and list any newly exposed issue. This is a test-only change: do not rerun all executor/Agent packages without a specific new concern.
- [ ] Commit only owned test edits. Deliver full BASE..HEAD, unchanged semantic assertions, real request/error observations, raw RED/GREEN/failed receipts and physical/Git source bindings to task-1-report.md in this plan's root SDD workspace; stop writes for fresh Sol review.

## Root self-review

The current M61 source assumes output.error before R4A's envelope, while the close case assumes a legacy English error string. Neither difference justifies accepting absent result data, an arbitrary rejection or dropping the real request/queue assertions. This packet proves the modern representation through actual existing owners and closes only these two test contracts. Product defects, other steering/fork/importSeed obligations and the larger IC-B/R6 work remain separate.
