# R4A — Child completion observation qualification

> **For agentic workers:** Use subagent-driven-development: one GPT6.1Sol implementer, a fresh independent GPT6.1Sol reviewer and root acceptance. No recursive agents. This is a continuation of approved work, not a new user approval checkpoint.

**Goal:** Close the three concrete subagent status-test failures using their actual observation owners, preserving prior-result settlement and serialized followup safety.

**Architecture:** Keep the existing separate TaskRecord, foreground summary, resident AgentTable and JobRegistry boundaries. A completed summary is not a promise of an atomic transaction across every mirror. Tests wait the existing event or original completion promise that owns their assertion. No production change is presumed.

**Predecessor:** [Native outcome acceptance](../../research/2026-10-20-context-r4a-native-outcomes-acceptance.md), product3cf3bc12/handback5a2c60f3, root acceptancec0bd3536. User authorizes continuous root-led GPT6.1Sol work. Product0.1.13-rc.1, Session10 and original27/43 remain unchanged; no publishing.

## Source-grounded rulings

1. `followup/drive.ts` serializes on the original `entry.followupChain`, then settles the previous result before clearing its data, publishing running and invoking guest followup. One `await Promise.resolve()` is not a running-event contract. Use the actual subscribed running patch or guest-entered signal.
2. `tasks.wait` completes when its TaskRecord has an outcome. Initial lifecycle `onSettled` also saves/publishes the task's F1 end/summary, then the original child lifecycle publishes resident/job mirrors and closes its initial generation. Those are separate promises.
3. `spawn_agent(background:false)` promises the task summary. Keep exact completed outcome/resultText assertions. Before asserting resident/job terminal state, capture and join that child's **original initial completion**. Do not repeatedly read a followupChain that future work could extend.
4. Existing `job_output` without wait is a nonblocking observation. A test asserting an already completed job first joins its own original initial completion, preserving the TaskRecord outcome assertion separately. Do not treat TaskRecord.wait as JobRegistry.wait. Existing wait:true semantics stay unchanged.
5. Keep real original factories, source/call identity, full text, exact running/terminal publication counts, fresh controller and old-output clearing assertions. No longer sleeps/timeouts, removed assertions, swallowed rejection, artificially completed registry, or early success before retention/F1.
6. This is expected to be tests-only contract correction/qualification. If the correct original event/promise join still leaves inconsistency, reproduce that original-owner defect and send root a concrete design ruling request before production expansion. Passing new controls are characterization, not fabricated product RED.

## Files and exact controls

Primary file: `packages/subagent/test/tools.test.ts`, the three named tests:

- `publishes complete followup lifecycle patches and clears previous output at start`
- `background:false blocks until the task settles and returns the summary`
- `job_output still reads subagent jobs (unchanged path)`

Read original `followup/drive.ts`, `child/lifecycle.ts`, `child/result.ts`, `tools/spawn.ts`, `tools/spawn-source.ts`, `task/registry.ts` and `tools/status.ts` as needed. A small adjacent test file/helper may hold the prior-settlement discriminator. Production owners and public exports remain unchanged unless root approves an evidenced defect.

- [ ] Reuse the saved exact three failures from the native handback; preserve their original oracle and source provenance. A focused unchanged run may confirm this unit's BASE; no repeated whole-baseline loop.
- [ ] For followup running readiness, use an event-owned deferred signal. Keep old text/error clearing, new controller, startedAt, no early waiting while guest held, exact two patches, and full new result after release. Cleanup releases every held gate and joins the actual drive.
- [ ] Add a held previous-result settlement control through the actual original capture/settlement handle and drive. A wrapper may hold/delegate the original settle method without replacing its owner identity. While held, no new running patch, guest followup, old-output clearing or second capture; after release, exactly one real followup. A rejected prior settlement must leave its original evidence and prevent starting new guest work. Distinguish this lifecycle control from a claim of complete durable artifact validation.
- [ ] Foreground summary assertion stays unchanged. Capture the initial completion before any followup is enqueued, join that exact handle, then assert resident waiting/job terminal, full text and one child execution. Do not force atomic mirror visibility or wait future followup work.
- [ ] The nonblocking job_output test keeps its TaskRecord completed assertion, separately joins the same original initial completion, then reads and asserts full completed output. Count the terminal publication at its real owner and retain single child execution; no generic status stub.
- [ ] Run the entire tools.test.ts plus the new focused settlement control and existing native-outcomes observation/control test sequentially at stable source; run subagent types. Select existing retained followup/task owner tests where they cover the changed fixture contract, rather than a whole-workspace sweep.
- [ ] Self-review and commit tests coherently. Write exact delivery/source-time evidence, classify old-oracle versus qualification results, and freeze for fresh independent review. If product stays unchanged, no redundant renderer/build/copy run is required; prior copy proof is not mislabeled as execution of these new tests.

## Evidence and continuation

Use `.superpowers/sdd/2026-10-20-context-r4a-child-completion-qualification/` and a fresh `.tmp/context-r4a-child-completion-20261020-implementation/`. Record complete tracked and untracked touched source/test hashes before and after every sequential run, exact commands/timing/exit/raw log. Use package-root Vitest with one worker; explicitly join each tool process before the next test. Preserve failed/setup results and don't overwrite earlier evidence.

This accepts child lifecycle observation qualification only. No live provider, cold artifact recovery, installed host, automatic background wake, whole-R4A or release claim. Root proceeds to [explicit result pages](2026-10-20-context-r4a-explicit-result-pages.md) after independent acceptance.
