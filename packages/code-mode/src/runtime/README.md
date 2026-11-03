# Code Mode runtime ownership

`../index.ts` is the unchanged package entry; `../runtime.ts` assembles the
runtime and retains its public wait/terminate methods. The private modules use
the existing `.js` import convention. Public contracts remain in `../types.ts`;
catalog, session store replay (`../state.ts`), broker, registration and worker
sources retain their existing independent owners.

| Module | Responsibility and lifetime |
|---|---|
| `limits.ts` | Configuration bounds, strict JSON transfer accounting, bounded diagnostics and UTF-8 slicing; original defaults and errors. |
| `cell-state.ts` | One cell registry, committed session JSON map and global producer set per runtime. Cell objects retain their original tool-controller and producer collections. Capabilities expose live membership; no second registry or copied mutable state. |
| `admission.ts` | One admission count, immutable origin, store/catalog snapshots, active-cell reservation and started-event fence; then one worker, registry insertion, handler attachment and observation. |
| `worker-events.ts` | Actual worker handlers/watchdogs, owner-abort linkage, nested tool dispatch and the original producer finalizer. Options remain lazy method calls on their original receiver. |
| `retirement.ts` | One stop set, durable commit queue, cancellation epoch/barrier and disposal promise. Guest execution stops before store completion; output admission, commit, closed event, local store publication and status/wake retain their order. Disposal reads the current public runtime cancel method. |
| `output.ts` | Output admission barrier, single observer/wake, consumed-window detachment, preview cursor and one lazily allocated spill store. Retention failures and cancellation retain their original handling. |

The output factory's 131-line AST span exceeds the proposed 120-line review
trigger because its two focused operations share the one spill-store lifetime
and cell output barrier. Its operational functions remain under 120 lines; it
does not hold a registry or move the entire original factory into a context bag.

The worker constructor moved from `../runtime.ts` to `admission.ts`. Its URL is
`new URL('../worker.mjs', import.meta.url)`, resolving to the same original
`packages/code-mode/src/worker.mjs`; `workerData` and `execArgv: []` are unchanged.
The real-worker runtime, store, retention and image-admission suites exercise
startup, tools, cancellation and commit behavior. Observation early return
remains distinct from producer cancellation; no new completion notification
or event-loop semantics are introduced here.

Run gates sequentially from the repository root:

```text
pnpm --filter @i-harness/code-mode exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/code-mode typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/event-driven-steering.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor typecheck
pnpm --filter @i-harness/core-tools exec vitest run test/observation.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-tools typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```
