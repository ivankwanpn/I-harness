# Native runner ownership

`../runner.rs` retains the public `run` and `fatal` entrypoints and all existing
embedded Rust tests. The production loop captures the private channels, drains
events, observes the owner, joins completed workers, drains their final events,
publishes I/O settlement, attempts release, and then receives the next control.

| Module | Responsibility and owned state |
| --- | --- |
| `status.rs` | Sole `OnceLock<Mutex<File>>` for the captured private status handle; version 1 JSON frames, bounded serialization, newline and flush ordering. |
| `control.rs` | Owns the private control reader thread and bounded channel; unchanged line limits, parsing, truncation errors and EOF ordering. |
| `prepared.rs` | Effective policy, PSEC, configured Jobs and prepared transport before commit. Owns suspended creation, attributes and prepared rollback. Transfers its backing owners once into `Running`. |
| `running.rs` | Sole process/thread handle owner and native lifecycle authority: assignment/resume, root/tree/I/O observations, MSYS observer, cancellation, termination retry, release and last-resort `Drop`. |
| `event_drain.rs` | Routes worker events through narrow `Running` operations and emits public acknowledgements/errors. `_owned-stop` delivery remains private to its native owner. |
| `dispatch.rs` | Owns command admission IDs, the one-prepare/one-commit fences, precommit owner and release correlations. Calls typed owner operations; owns no running process handles. |

The facade owns the `Option<Running>`, the one-consumption output file and event
channels. Dispatch's prepared state is not copied into an auxiliary context, and
event draining never creates a second handle or lifecycle authority. Selected
owner fields retain `pub(super)` visibility solely for the unchanged embedded
tests; production dispatch/drain operations use owner methods. Private modules
are not reexported. Prepared imports Running and its backing owner type;
Running depends only on status and the existing crate owners. Production module
dependencies flow downward with no reverse imports or callbacks.

Field/drop order is preserved. After prepared transport starts, the process and
primary thread enter `Handle` RAII before the effective policy/PSEC/Jobs transfer.
`Running` still declares process, primary thread, transport, then prepared owner
in the original order. Release closes pending endpoints, thread, process and
outer Job, releases the effective/MSYS image owner and workload Job, and only
then removes PSEC if all closes succeeded. Failed close/termination operations
retain their owners and diagnostic causes for retry. Assignment failure still
terminates the actual unassigned suspended process. The fatal path keeps the
original five-second drop drain and deliberately retains PSEC when tree/drain
completion cannot be established.

Root exit, Job emptiness and output EOF are separate observations. Worker
completion is joined, and its final retained-handle/error events are drained,
before `io-settled`. A retained descendant still owns the Job after its root
exits. Release requires all three observations; EOF cannot imply settlement.

This decomposition preserves the 10 ms control polling and native observation
cadence. E8 event migration is separate work. Windows PSEC ConPTY remains
unsupported and the four PSEC/MSYS pipe/matrix qualification cases remain
unsupported on the observed host. The shipped record remains experimental,
historical to one host and incomplete. Prototype event-gate results are not
product qualification evidence.

Run gates sequentially from the repository root:

```text
pnpm --filter @i-harness/sandbox-windows-psec test:native
pnpm --filter @i-harness/sandbox-windows-psec build:native
pnpm --filter @i-harness/sandbox-windows-psec smoke:native
pnpm --filter @i-harness/sandbox-windows-psec qualify:windows
pnpm --filter @i-harness/sandbox-windows-psec exec vitest run test --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/sandbox-windows-psec typecheck
```

Build and test invoke Windows PowerShell 5 using the installed compiler and
pinned SDK. Release build records all nested source paths recursively. Integrity
coverage compares every Rust source with the actual manifest and independently
mutates each of the six nested modules in an owned fixture to prove rejection.
Qualification writes fresh owned fixture evidence; derive the shipped record
from that evidence and the fresh build manifest while preserving its previous
record in qualification history. An unsupported qualification yields child exit
2 and pnpm outer exit 1, and is explicitly incomplete.
