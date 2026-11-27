import type { ConnectedMcpClient } from "../client.ts"
import { installToolCatalogue, readToolCatalogue, registerMcpTool } from "../bridge.ts"
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
  const resources = new Map<string, () => void>()

  type CatalogueRefresh = { controller: AbortController; work: Promise<void>; waiters: number }
  type CatalogueState = { dirty: boolean; changes: number; retryAt: number; refreshing?: CatalogueRefresh }
  // Mount, refresh and reconnect share a registry. Each connection owns its
  // own announcements, backoff and active refresh, including late replies.
  const freshState = (): CatalogueState => ({ dirty: false, changes: 0, retryAt: 0 })
  let active = freshState()
  const reset = () => { active = freshState() }
  const markCatalogDirty = (): void => {
    active.dirty = true
    active.changes++
  }

  const unregister = (registrations: Map<string, () => void>): void => {
    for (const [name, dispose] of registrations) {
      dispose()
      registrations.delete(name)
    }
  }
  const unregisterAll = (): void => {
    unregister(disposers)
    unregister(resources)
  }

  const resyncTools = async (signal?: AbortSignal): Promise<void> => {
    const source = active
    const epochAtStart = source.changes
    const owner = current()
    if (!owner) throw new McpServerUnavailableError(serverName)
    // A cursor and every page it addresses belong to the same connection.
    // Registered tool calls continue to use the stable routing proxy.
    const registry = deps.tools
    const assertCurrent = () => {
      if (active !== source || current() !== owner) throw new McpServerUnavailableError(serverName)
    }
    const catalogue = await readToolCatalogue((cursor, opts) => {
      assertCurrent()
      return owner.listTools(cursor, opts)
    }, config, signal)
    assertCurrent()
    signal?.throwIfAborted()
    const previousDisposers = disposers
    disposers = installToolCatalogue(catalogue, proxy(), registry, config, previousDisposers)
    try {
      unregister(resources)
      for (const tool of createResourceTools(proxy(), serverName, config)) {
        resources.set(tool.name, registerMcpTool(deps.tools, tool))
      }
    } catch (reason) {
      unregisterAll()
      throw reason
    }
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
    if (source.changes === epochAtStart && (disposers.size > 0 || previousDisposers.size === 0)) source.dirty = false
  }

  const joinRefresh = (flight: CatalogueRefresh, signal?: AbortSignal): Promise<void> => {
    flight.waiters++
    if (!signal) return flight.work.finally(() => { flight.waiters-- })
    return new Promise<void>((resolve, reject) => {
      let attached = true
      const detach = () => {
        if (!attached) return
        attached = false
        signal.removeEventListener('abort', stop)
        flight.waiters--
      }
      const stop = () => {
        detach()
        if (flight.waiters > 0) reject(signal.reason)
        // The last waiter cancels the physical page and joins its exit. An
        // injected client that ignores signal remains owned until it settles.
        else flight.controller.abort()
      }
      void flight.work.then(() => {
        detach()
        if (signal.aborted) reject(signal.reason)
        else resolve()
      }, error => { detach(); reject(signal.aborted ? signal.reason : error) })
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
    })
  }

  const refreshCatalog = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason)
    // Refresh is not a rejected tool call, so it bypasses onToolUnavailable.
    const owner = current()
    if (owner === undefined) return Promise.reject(new McpServerUnavailableError(serverName))
    // Single-flight guards refresh-vs-refresh. start/attempt drain directly
    // after adoption while still connecting/reconnecting; a second drain then
    // would race over the same previous disposers. That drain IS the rebuild,
    // and its epoch guard keeps any newer announcement dirty after ready.
    if (state() !== "ready") return Promise.resolve()
    // A failed drain leaves the flag dirty but gives the server one full drain
    // budget of quiet, avoiding a timeout on every awaited step boundary.
    const source = active
    if (Date.now() < source.retryAt) return Promise.resolve()
    const currentRefresh = source.refreshing
    if (currentRefresh) {
      if (!currentRefresh.controller.signal.aborted) return joinRefresh(currentRefresh, signal)
      const retry = () => {
        if (active !== source || current() !== owner) throw new McpServerUnavailableError(serverName)
        return refreshCatalog(signal)
      }
      return currentRefresh.work.then(retry, retry)
    }
    const controller = new AbortController(), done = Promise.withResolvers<void>()
    const flight = { controller, work: done.promise, waiters: 0 }
    source.refreshing = flight
    const waiting = joinRefresh(flight, signal)
    void resyncTools(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) source.retryAt = Date.now() + (config.catalogTimeoutMs ?? 60_000)
      throw error
    }).finally(() => { source.refreshing = undefined }).then(done.resolve, done.reject)
    return waiting
  }

  return {
    markCatalogDirty,
    catalogDirty: () => active.dirty,
    clearDirty: reset,
    resetForGeneration: reset,
    resyncTools,
    refreshCatalog,
    unregisterAll,
  }
}

export type SupervisorCatalogue = ReturnType<typeof createSupervisorCatalogue>
