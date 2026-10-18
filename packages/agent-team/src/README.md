# Agent team scheduling

The package public entry is `index.ts`. `scheduler.ts` keeps `mountAgentTeams`
and its original `TeamDeps`, `TeamSubagentDeps`, and `TeamMountHandle` contracts.
The five modules under `scheduler/` are private implementation owners.

| Owner | Responsibility |
| --- | --- |
| `scheduler/admission.ts` | Config validation, one module-level live-team reservation set, canonical durable team identity, folded-state creation, trusted tool caller resolution |
| `scheduler/teammate-lifecycle.ts` | Generated role definition, exact spawn/model/fork options, child interrupt/close, runtime member status |
| `scheduler/task-delivery.ts` | Durable target inbox append and flush, Lead admission/wake, resident rebuild and shared serialized child followup drive |
| `scheduler/completion.ts` | Job registry bridge, one completion count map and pending-job set, bounded UTF-8 result notices while retaining full job output |
| `scheduler/recovery.ts` | Nondestructive durable-child probes, one mounted-tool list and replacement map, unmount drain and restoration |
| `scheduler.ts` | Domain assembly, generated-role ownership and one unmounted latch, explicit recovery/publication order |

`fold.ts` and `transact.ts` remain authoritative for committed team state.
Roster, mailbox, and task board receive the same folded state and transaction;
the scheduler owners retain those references. Existing agent table, jobs,
roles, and agent registry retain their authority. Private dependencies expose
only the fields used by each owner, while forwarding the original host objects.
Completion callbacks read mailbox/activity only when a job settles; spawn reads
the final role tool list only when needed. Host admission and coordinator fields
remain live across awaits, with their original method receivers.

Mount validates config before reserving a team, derives its identity from the
durable team ledger, assembles the domains, publishes the generated role,
reconciles provisioning members, replays queued messages, then installs tools.
The role's grants derive from the actual tool list and exclude Lead operations.
An existing custom role stays authoritative. Caller identity uses the actual
parent or durable child session identity and the shared roster.

Delivery appends the target inbox and flushes before mailbox acknowledgement.
Lead admission follows the target flush; explicit Stop/disposal suppression uses
the existing parent admission contract. Child wakeup follows durable append and
uses subagent's existing `driveFollowups`, retaining its one per-entry chain.
Recovery probes call `snapshot`, never repairing `load`/`loadOwned`. The spawn
checkpoint flushes before probing; restored provisioning probes read the log.
Completion only observes transitions from running, suppresses stopped/failed/
unmounted targets, and retains full output independently of notice truncation.

Unmount marks the same latch first, closes activity waiters, awaits pending
completion jobs, disposes owned `lead/*` children best effort, unregisters team
tools, restores replaced tools, then removes the exact generated role and live
reservation in the existing finally boundary. The mount catch retains the same
release order. Existing partial-mount rollback and scope cleanup limitations
remain for I4/E2; this decomposition adds no completion semantics.

Run these commands **from the repository root, sequentially**. Do not overlap
the package/consumer suites or native jobs. The verified S19 gates are team
115 tests/12 files, subagent consumers 108/3, executor assembly 47/1, and all
three package typechecks. Team lifecycle has two existing absent-tool fixture
warnings; the subagent consumer fixtures also report existing absent-tool
warnings. The two new lifecycle characterization cases pass on original and
split sources and cover live admission across flush plus blocked disposal.

```powershell
pnpm --filter @i-harness/agent-team exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/agent-team typecheck
pnpm --filter @i-harness/subagent exec vitest run test/resume.test.ts test/task-notification.test.ts test/tools.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/subagent typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/assembly.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

The 139-line mount is a cohesive assembly sequence with public contracts above
it. Its business bridges live in the five owners; another async wrapper would
hide recovery awaits and cleanup boundaries. All private operations are under
the 120-line review trigger. The smaller modules each own a complete responsibility
and are not padded to meet the suggested module size range.
