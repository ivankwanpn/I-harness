import type { ConnectedMcpClient } from "../client.ts"
import { syncTools } from "../bridge.ts"
import { createResourceTools } from "../resources.ts"
import { McpServerUnavailableError } from "../errors.ts"
import type { McpServerConfig } from "../types.ts"
import type { McpServerState, SupervisorDeps } from "./types.ts"

/** Owns catalogue announcements, drains and registrations; generation is a live view. */
export function createSupervisorCatalogue(
  config: McpServerConfig,
  deps: Pick<SupervisorDeps, "tools">,
  serverName: string,
  current: () => ConnectedMcpClient | undefined,
  state: () => McpServerState,
  proxy: () => ConnectedMcpClient,
) {
  let disposers = new Map<string, () => void>()
  let resourceToolNames: string[] = []

  // M6-D3: the catalogue's staleness. The FLAG says "the registry does not
  // reflect the server's list"; the EPOCH counts announcements, which is what
  // makes a rebuild's clear safe — a list that changed WHILE the drain was in
  // flight is not the list we just installed, so that rebuild must leave the
  // flag set for the next boundary (see resyncTools). The flag is per
  // GENERATION — adopt, generationDown, goLost and close all reset
  // it, because a superseded generation's announcement says nothing about the
  // live one. The EPOCH is deliberately NOT reset with it: it is monotonic, a
  // pure count of announcements, and the only thing ever done with it is a
  // comparison against the value a drain captured at its start — resetting it
  // could only let a stale captured value look current again.
  let catalogDirtyFlag = false
  let catalogEpoch = 0
  // Final review: when a FAILED rebuild is allowed to be retried. The flag
  // stays dirty (it is not lying — the catalogue IS stale), but the RETRY is
  // throttled, because the boundary AWAITS the rebuild (core-plugin's emit
  // awaits promise-returning plain listeners)
  // and a server that announces list_changed and then stalls would otherwise
  // cost up to one catalogTimeoutMs at every step boundary, unbounded. Set to
  // the failure instant + one full drain's budget (the same `?? 60_000`
  // bridge.ts derives its deadline from); reset when a generation is
  // adopted, because a failed drain says nothing about a NEW generation's —
  // which drains itself anyway.
  let catalogRetryNotBefore = 0
  // M6-D3 single-flight: the rebuild in flight, shared by every concurrent
  // caller (the same idiom as oauth.ts's `refreshInFlight`). Two boundaries CAN
  // be in flight at once — the emitter's plain listeners live on an ancestor
  // scope and a DETACHED child turn reaches them (core-plugin's emit walks
  // parent-ward; subagent/child.ts runs the child's turn without awaiting it),
  // so a teammate's step and the lead's next step can both arrive here. Two
  // overlapping drains would keep the SAME previous-disposers map: the loser
  // disposes names the winner had just re-registered, registration throws
  // duplicate, and bridge.ts's rollback path returns an EMPTY map — the
  // supervisor's `disposers` would then be empty, a live tool silently missing
  // and a stale one undesposable. One drain, one promise: every caller waits
  // for the same rebuild.
  let refreshing: Promise<void> | undefined

  const markCatalogDirty = (): void => {
    catalogDirtyFlag = true
    catalogEpoch += 1
  }

  const unregisterAll = (): void => {
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
    for (const name of resourceToolNames) deps.tools.unregister(name)
    resourceToolNames = []
  }

  const resyncTools = async (): Promise<void> => {
    const epochAtStart = catalogEpoch
    // Two-phase swap (bridge.ts): fetch/build before disposing the previous
    // tools and registering the fresh list. Resource tools are then re-bound.
    const previousDisposers = disposers
    disposers = await syncTools(proxy(), deps.tools, config, previousDisposers)
    for (const name of resourceToolNames) deps.tools.unregister(name)
    const resourceTools = createResourceTools(proxy(), serverName, config)
    resourceToolNames = resourceTools.map((t) => t.name)
    for (const rt of resourceTools) deps.tools.register(rt)
    // M6-D3: the rebuild consumed the announcement it was drained for — UNLESS
    // a list_changed arrived while those pages were in flight: that list is
    // newer than what we just installed, so the flag stays set and the next
    // boundary drains again. A rebuild that THREW never reaches this line, so a
    // failed refresh also stays dirty (retried at the next boundary, on the
    // failure backoff).
    //
    // A swap that returned ZERO disposers is the ambiguous case (final review):
    // either the server's list is genuinely empty, or bridge.ts's re-sync
    // rollback zeroed a populated catalogue after a Phase-2 registry conflict
    // (the silent-zeroing path, which returns an empty map rather
    // than throwing). Clearing the flag for the second reading would leave the
    // server with no tools and no retry. So the flag is cleared only when the
    // swap PRODUCED disposers, or when there was no catalogue to lose (the
    // predecessor was already empty — a genuinely empty list costs one extra
    // drain at the next boundary, which then sees an empty predecessor and
    // clears).
    if (catalogEpoch === epochAtStart && (disposers.size > 0 || previousDisposers.size === 0)) catalogDirtyFlag = false
  }

  const refreshCatalog = (): Promise<void> => {
    // Refresh is not a rejected tool call, so it bypasses onToolUnavailable.
    if (current() === undefined) return Promise.reject(new McpServerUnavailableError(serverName))
    // Single-flight guards refresh-vs-refresh. start/attempt drain directly
    // after adoption while still connecting/reconnecting; a second drain then
    // would race over the same previous disposers. That drain IS the rebuild,
    // and its epoch guard keeps any newer announcement dirty after ready.
    if (state() !== "ready") return Promise.resolve()
    // A failed drain leaves the flag dirty but gives the server one full drain
    // budget of quiet, avoiding a timeout on every awaited step boundary.
    if (Date.now() < catalogRetryNotBefore) return Promise.resolve()
    if (refreshing === undefined) {
      refreshing = resyncTools()
        .then(
          () => undefined,
          (err: unknown) => {
            catalogRetryNotBefore = Date.now() + (config.catalogTimeoutMs ?? 60_000)
            throw err
          },
        )
        .finally(() => {
          refreshing = undefined
        })
    }
    return refreshing
  }

  return {
    markCatalogDirty,
    catalogDirty: () => catalogDirtyFlag,
    clearDirty: (): void => { catalogDirtyFlag = false },
    resetForGeneration: (): void => {
      catalogDirtyFlag = false
      catalogRetryNotBefore = 0
    },
    resyncTools,
    refreshCatalog,
    unregisterAll,
  }
}

export type SupervisorCatalogue = ReturnType<typeof createSupervisorCatalogue>
