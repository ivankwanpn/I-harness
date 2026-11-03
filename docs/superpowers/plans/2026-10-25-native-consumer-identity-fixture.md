# Native consumer authenticated-dispatch fixture correction

> **For agentic workers:** Use subagent-driven-development or executing-plans for this bounded task. Root owns independent review and integration.

**Goal:** Qualify the actual durable child/nested Code Mode ownership behavior through the shipping parent dispatcher, preserving the real failure from stage076.

**Architecture:** Keep the existing JSONL coordinator, automatically acquired result store, native execution service and child Code Mode. Replace only the positive fixture's identity-less convenience invocation with the actual parent Agent run. Missing/spoofed callers remain rejected; no product fallback supplies invented authority.

**Binding evidence:** `.superpowers/sdd/2026-10-24-windows-native-event-owner/consumer-076-diagnosis.md` traces the exact failure and controlled artifacts. It is source/data attribution, not a pre-N2 baseline execution claim. The original076 receipt remains failed18/19.

## Constraints

- Test-only task: `packages/session-executor/test/execution-authority.test.ts`; a cohesive test helper/new adjacent test file is allowed only if needed for authentic receipt reading. No product, provider, bootstrap, retention guard, report-policy or native asset change.
- Use real existing owners and actual native jobs. No always-available retention, fake confirm/read, sourceFor removal, descriptor fallback or accepting a recovery error as successful completion.
- GPT-6.1 Sol; no subagents. One writer/runtime per checkout. Preserve protected untracked diagnostics and every original failure/fixture. Product0.1.13-rc.1/Session12 remain; no push/tag/release.
- Sequential package-CWD Vitest `--maxWorkers=2 --minWorkers=1`, isolated existing configuration directory. Use the exact frozen N2 candidate's real helper/template; no asset rebuild or hash edits.

### Task 1: Exercise parent and child through authentic source ownership

1. Read the diagnosed test and existing `retained-result-host.test.ts` Agent pattern. Preserve original076 evidence and capture the current test's source/command/result binding before editing. The behavior RED is already preserved; do not rerun an unchanged whole suite solely to regenerate it.
2. Use this controlled mock order through `assembly.agent.run`: parent owner_probe → parent synchronous spawn_agent → child code_exec owner_probe → child final `done` → parent final. Keep the actual closure over the execution service and original two ExecutionReceipt assertions. The parent calls now receive actual session/call/settlement identities through the shipping dispatcher; do not manufacture a prepared descriptor.

```ts
const model = createMockClient([
  { role: 'assistant', toolCalls: [{ name: 'owner_probe', args: {} }] },
  { role: 'assistant', toolCalls: [{ name: 'spawn_agent', args: {
    task_name: 'identity', agent_type: 'owner-worker', message: 'probe',
    fork_turns: 'none', background: false,
  } }] },
  { role: 'assistant', toolCalls: [{ name: 'code_exec', args: {
    code: 'text(await tools.owner_probe({}))', yield_time_ms: 1000,
  } }] },
  { role: 'assistant', text: 'done' },
  { role: 'assistant', text: 'parent done' },
]);
// Run on the original actual assembly/coordinator/native fixture.
const outcome = await assembly.agent.run('Run the controlled ownership probes');
expect(outcome.finalText).toBe('parent done');
```

3. Preserve main/child receipt identity, durable parentSession metadata, child-local Code Mode and execution-job ownership checks. Additionally require the completed task's actual retained JSON artifact to decode to `{resultText:'done'}` through the real trusted-parent read route. A separately created unrelated session must be denied. No matching string/listJobs assertion substitutes for actual artifact read authorization.
4. Keep the existing spoofed-child-before-body refusal. Add a separate identity-less convenience dispatch negative using controlled child completion: its result remains honestly unsupported-owner/recovery and has no claimed durable task artifact. It must not be reclassified as a successful parent dispatch or given a product fallback. Avoid reusing that negative to inflate the positive's two receipt counts.
5. On all paths, close/kill only the exact owned jobs and dispose the real owners. Already-terminal jobs use the existing idempotent/terminal lifecycle contract; do not mistake a naturally finished job for a new cancellation failure. A bounded workload timing adjustment is fixture setup only and must be reported. Do not alter expected ROOT/EOF/resource facts to obtain green results.
6. Run the corrected named case and its new negatives, then the exact original076 focused consumer set once on frozen source, plus executor typecheck. Preserve raw command/cwd/environment/exit, hashes and original failures. If the authenticated path still fails, report the concrete product cause before modifying any product code.
7. Commit only scoped test files, write the full report with BASE..HEAD and the exact native identities. Root creates the review package; no claim of whole N2/Task6 or version completion from this fixture alone.
