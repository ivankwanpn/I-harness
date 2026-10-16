# MCP connection supervisor

`../supervisor.ts` is the internal factory facade. The package's existing
`../index.ts` re-exports its factory and public types; `./config` continues to
resolve to `../config-store.ts`. No private helper is a package export.

| Module | Authority and contract |
| --- | --- |
| `types.ts` | The existing supervisor API, dependency contract and host status event (including `authRefreshFailed`). |
| `status.ts` | `closed`, lifecycle state, attempts and last error. Status callbacks are read lazily and suppressed after close. |
| `generation.ts` | The sole current connection, stable proxy, shared connect options, adoption and startup. Proxy methods consult the current connection on every call and preserve its receiver and all arguments. Startup connection/sync failures reject as mount failures. |
| `catalogue.ts` | Tool disposer map, resource names, dirty flag, monotonic announcement epoch, refresh promise and retry deadline. It consumes live current/state/proxy getters and performs the existing two-phase tool swap followed by resource withdrawal and registration. |
| `recovery.ts` | Retry and stability timers, death ownership checks, reconnect attempts and terminal loss. It consults the generation owner instead of storing another current connection. |
| `disposal.ts` | Bounded generation close and supervisor close ordering. Close marks the status owner closed before timer, disposer, registry or connection callbacks run. |

The factory eagerly reads `serverName` and reconnect enabled/initial delay/max
delay/retry count in the original order. Helpers retain `config` and `deps`
references. They do not capture the registry or dependency callbacks during
construction: a drain passes the current `deps.tools` to `syncTools`, then reads
`deps.tools` again for each resource operation after the await. The shared
connect-options object is retained across startup and retries.

The catalogue clears dirtiness only if its epoch is unchanged and the swap
produced disposers or had an empty predecessor. Announcements during a drain
remain dirty, as does an ambiguous empty rollback. Adoption clears the dirty
flag and failed-drain deadline, without resetting the epoch or refresh promise.
Refreshes share one promise; connecting/reconnecting drains are readiness
barriers. A failed refresh reads the live `catalogTimeoutMs` at failure and
waits one full drain budget before retrying. An unavailable refresh rejects
without firing the rejected-tool callback.

Retry delay is `min(maxDelayMs, initialDelayMs * 2 ** (next - 1))`; a generation
that survives `maxDelayMs` resets attempts. These two timers are cleared on
close and unref'd so they cannot keep an unmounted process alive. The temporary
close timer retains its original clear-in-finally behavior. A failing generation
must close within 5,000 ms before retry; timeout ends recovery to prevent
overlapping stdio processes. Loss and close withdraw current/tools/dirty state
in their original order.

This extraction preserves existing callback and startup control flow. The shared
`onToolsChanged` marker can still run after a generation retires or the supervisor
closes. Initial startup also retains its lack of a post-resync generation/closed
ownership guard. These require generation and catalogue commit fencing in later
MCP behavior work; this decomposition does not claim to harden those races.
Existing resource-template proxy behavior is preserved as well.

Run checks sequentially from the repository root:

```powershell
pnpm --filter @i-harness/mcp-client exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/mcp-client typecheck
pnpm --filter @i-harness/core-tools exec vitest run test/tools.test.ts test/dispatch-authority.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-tools typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

`reconnect.test.ts` covers recovery ownership, budget, dirty/epoch behavior,
readiness, failed-drain quiet time, rollback and single-flight.
`supervisor-contract.test.ts` covers proxy identity/receiver/arguments, lazy
dependencies and registry/status replacement during an await, pending connect
cleanup after close, and refresh rejection versus rejected-tool callbacks.
Lifecycle and local OAuth fixtures continue to cover mount/connected-client
integration. OAuth failure/offline diagnostics are intentional fixture output.
