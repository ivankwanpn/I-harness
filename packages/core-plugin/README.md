# Core Plugin maintenance map

The package entry remains `src/index.ts`. It exports the existing `Plugin`,
`PluginContext`, handler types, `createContext`, version and cascade redispatch
helpers. The internal factories are not additional package entry points.

| Module | Responsibility and state owner |
| --- | --- |
| `src/types.ts` | Public Plugin/context and handler contracts. |
| `src/redispatch.ts` | Global redispatch symbol and payload marker helpers. |
| `src/scope/types.ts` | Internal ancestor traversal and service-store types. |
| `src/scope/create-scope.ts` | Assemble one context and its child-scope Set; connect live scope and mounting-owner getters. |
| `src/scope/services.ts` | One local service Map and a live reference to the immediate parent's Map. |
| `src/scope/listeners.ts` | Plain listeners, their plugin ownership, guards, decisions, emit and policy traversal. |
| `src/scope/waterfall.ts` | Waterfall handlers, their plugin ownership, snapshots and release-chain execution. |
| `src/scope/cascade.ts` | Cascade handlers, their plugin ownership, ancestor snapshots and around-call execution. |
| `src/scope/dispose.ts` | Plugin registry, nested mount relationships, mounting-owner stack, synchronous reclaim and bounded async disposers. |
| `src/scope/promise.ts` | Existing object-only PromiseLike predicate used by listeners and waterfalls. |

Factories allocate each scope's stores once. Accessors for the current context
and mounting plugin are evaluated only after assembly completes, so nested mounts
restore the same mounting stack and descendant dispatch sees current ancestor
state. Parent service Maps are referenced directly. Service lookup checks the
local and immediate parent stores; it does not walk all ancestors.

`emit` clears this event's decision, snapshots both listener and waterfall arrays,
runs plain listeners against the emitted payload, then runs the waterfall and
propagates its result to the parent. Only a non-undefined plain-listener return on
an event with a waterfall creates a decision; the last such return supplies the
seed. A waterfall normalization alone does not create a decision. Listener,
waterfall, cascade and guard errors propagate as control-flow errors. They are
not optional observer notifications.

Every waterfall handler must call `next` once, including the last handler. A
nullish return falls back to that handler frame's incoming payload. Cascade
handlers wrap the final function from root to child in registration order, may
short-circuit, and may call `next` at most once. Each cascade dispatch snapshots
every scope before executing any handlers. The redispatch marker remains a
`Symbol.for` property and is absent from JSON serialization.

Guard checks walk self to root, returning the first non-undefined deny reason.
Decision lookup takes the nearest recorded value, while ancestor-only lookup
starts at the parent. `emit` returns its own per-call result; shared recorded
decision slots retain their existing behavior across concurrent emits.

Plugin unmount synchronously deletes the registry entry, invokes the disposer,
reclaims nested plugins and removes listener, waterfall and cascade registrations
in that order. Only then does its returned Promise wait for collected async
disposers. Registry deletion precedes recursion to terminate same-name cycles.
Async disposers retain the 5000 ms deadline, unref'd timer and ambient
`shutdown` diagnostic with the existing timeout message. A synchronous disposer
throw still interrupts reclamation; guards and services are not plugin-owned
cleanup targets.

Known limitation carried to the separate I4/E2 lifecycle work: mounting a child
adds it to the parent's Set, while `child.scope.unmount()` deletes the child's
context from its own local Set. It does not dispose child resources, close the
context or establish recursive service inheritance. The existing sibling service
test does not prove child disposal. This decomposition preserves that behavior.

Run verification sequentially from the repository root:

```powershell
pnpm --filter @i-harness/core-plugin exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-plugin typecheck
pnpm --filter @i-harness/core-tools exec vitest run test/tools.test.ts test/dispatch-authority.test.ts test/guardian-seam.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-tools typecheck
pnpm --filter @i-harness/hooks exec vitest run test/hooks.test.ts test/command-binding.test.ts --maxWorkers=2 --minWorkers=1
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

`test/scope-contracts.test.ts` characterizes the moving seams, including snapshot
timing, live parent stores, overlapping emits, error propagation, nested mount
failure, redispatch serialization and reclamation before async disposal settles.
The reachability audit maps only the entry and these exact extracted modules to
the entry's original logical declaration owner. Unmapped files and external
consumers remain independent.
