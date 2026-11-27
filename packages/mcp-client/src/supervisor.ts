import type { McpServerConfig } from "./types.ts"
import type { McpSupervisor, SupervisorDeps } from "./supervisor/types.ts"
import { createSupervisorStatus } from "./supervisor/status.ts"
import { createSupervisorCatalogue } from "./supervisor/catalogue.ts"
import { createSupervisorGeneration } from "./supervisor/generation.ts"
import { createSupervisorRecovery } from "./supervisor/recovery.ts"
import { createSupervisorClose, createSupervisorLifetime } from "./supervisor/disposal.ts"

export type { McpServerState, McpServerStatusEvent, McpSupervisor, SupervisorDeps } from "./supervisor/types.ts"

// Generation-based reconnect supervisor — absorbed from dsh
// packages/mcp/mcp-client/src/connection.ts (MIT — see THIRD_PARTY_NOTICES):
//   - every reconnect builds a NEW client + transport (a "generation");
//   - transport death → generationDown (isCurrent guard makes it idempotent);
//   - backoff min(maxDelayMs, initialDelayMs * 2^(n-1)); a generation that
//     stays alive ≥ maxDelayMs (stability window) resets the attempt budget;
//   - beyond maxRetries: unregister ALL tools, stop reconnecting, emit "lost";
//   - overlap guard: a failing generation must close within 5s or reconnecting
//     stops, so stdio child processes for one server never overlap;
//   - every generation re-syncs: syncTools two-phase swap + resource tools
//     re-bound (unregister old names → register new).

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_RETRIES = 5

export function createMcpSupervisor(config: McpServerConfig, deps: SupervisorDeps): McpSupervisor {
  return createMcpSupervisorOwner(config, deps).supervisor
}

/** The mount's private reservation consumes the actual release separately from a bounded close attempt. */
export function createMcpSupervisorOwner(config: McpServerConfig, deps: SupervisorDeps) {
  // Preserve the original eager config reads and their order; deps stay live.
  const { serverName } = config
  const reconnectEnabled = config.reconnect?.enabled === true
  const initialDelayMs = config.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const maxRetries = config.reconnect?.maxRetries ?? DEFAULT_MAX_RETRIES

  const status = createSupervisorStatus(serverName, deps)
  const lifetime = createSupervisorLifetime(serverName)
  const catalogue = createSupervisorCatalogue(
    config, deps, serverName, () => generation.current(), status.state, () => generation.proxy,
  )
  const generation = createSupervisorGeneration(
    config, deps, serverName, reconnectEnabled, status, catalogue, lifetime,
    (gen) => recovery.generationDown(gen), (gen) => recovery.armStability(gen),
  )
  const recovery = createSupervisorRecovery(config, deps, serverName, initialDelayMs, maxDelayMs, maxRetries, status, generation, catalogue, lifetime)
  const retirement = createSupervisorClose(serverName, status, generation, catalogue, lifetime, recovery.clearRetry, recovery.clearStability)

  const supervisor: McpSupervisor = {
    client: () => generation.proxy,
    state: status.state,
    start: generation.start,
    close: retirement.close,
    catalogDirty: catalogue.catalogDirty,
    refreshCatalog: catalogue.refreshCatalog,
  }
  return { supervisor, released: retirement.released }
}
