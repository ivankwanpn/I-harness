import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessClient, ServerInfo } from "@i-harness/sdk"
import { DESKTOP_CONFIGURATION_ID } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import { DESKTOP_NOTIFICATION_METHODS, type DesktopEvent, type DesktopNotificationMethod } from "../shared/bridge.ts"

const FORWARDED_NOTIFICATIONS = new Set<DesktopNotificationMethod>(DESKTOP_NOTIFICATION_METHODS)
function isForwardedNotification(method: string): method is DesktopNotificationMethod { return FORWARDED_NOTIFICATIONS.has(method as DesktopNotificationMethod) }
import type { WorkspaceEntry } from "./workspaces.ts"
import type { DesktopProjectContext } from "./project-runtime.ts"
import { createSharedDesktopHost } from "./shared-desktop-host.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface WorkspaceRuntime {
  hostPid?: number
  client: HarnessClient
  info: ServerInfo
  sandbox?: SandboxState
  /** Cleanup receipt for the original workspace connection. */
  whenClosed?(): Promise<void> | undefined
}

export interface LaunchedRuntime {
  hostPid?: number
  client: HarnessClient
  ready?: Promise<void>
  /** Routing can be lost before the logical workspace finishes cleanup. */
  disconnected?: Promise<void>
  /** Resolves when the owning workspace is released or its process exits. */
  exited: Promise<void>
  /** Last stderr bytes of the child, for exit diagnostics. */
  stderrTail?: () => string
  exitInfo?: () => { code: number | null; signal: string | null } | undefined
  /** Structured fatal payload reported by the gateway before exit. */
  fatal?: string
}

/** A child that writes more than the pipe buffer holds would block forever if
 * nobody reads that stream; its diagnostics are not a protocol channel. */
export function drainChildStream(stream: NodeJS.ReadableStream | null | undefined): void {
  stream?.resume()
}

/** Drain a child stream while retaining a bounded tail for exit diagnostics. */
export function captureChildStream(stream: NodeJS.ReadableStream | null | undefined, limit = 8192): () => string {
  let tail = ""
  stream?.on("data", (chunk: Buffer | string) => { tail = (tail + chunk.toString()).slice(-limit) })
  stream?.resume()
  return () => tail
}

export interface WorkspaceRuntimeManager {
  peek?(workspaceId: string): WorkspaceRuntime | undefined
  pendingRuntime?(workspaceId: string): Promise<WorkspaceRuntime> | undefined
  invalidate?(workspaceId: string): Promise<void>
  /** Publish current native folder authority to ready and starting gateways. */
  refreshProjectContexts?(): Promise<void>
  get(workspace: WorkspaceEntry): Promise<WorkspaceRuntime>
  /** Explicit user recovery starts a fresh bounded failure window. */
  recover?(workspace: WorkspaceEntry): Promise<WorkspaceRuntime>
  onEvent(listener: (event: DesktopEvent) => void): () => void
  /** Close-time SDK query. Unknown state retains the process. */
  hasActiveWork(): Promise<boolean>
  /** Silently retire workspace gateways idle longer than ttlMs. */
  evictIdle?(ttlMs: number): Promise<number>
  close(): Promise<void>
}

const SANDBOX_MODES = new Set<SandboxState["mode"]>(["read-only", "workspace-write", "danger-full-access"])

/** A host may only claim the sandbox when every field says so. */
export function validateSandboxState(value: unknown): SandboxState {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  const mode = record?.mode
  if (record === undefined
    || record.wired !== true
    || record.source !== "settings"
    || typeof mode !== "string"
    || !SANDBOX_MODES.has(mode as SandboxState["mode"])) {
    throw new Error("desktop/sandbox/state returned an invalid sandbox claim")
  }
  return { mode: mode as SandboxState["mode"], source: "settings", wired: true }
}

/** Both idle eviction and application close require affirmative evidence that
 * the matching runtime has no work. Older gateways report this in two parts. */
async function runtimeIsIdle(runtime: WorkspaceRuntime): Promise<boolean> {
  const { client, info: { capabilities } } = runtime
  try {
    if (capabilities["desktop-runtime-activity"]?.includes("1")) {
      const state = await client.request("desktop/runtime/activity", {}, 2_500) as { active?: unknown } | null
      return state?.active === false
    }
    if (!capabilities["session-dashboard"]?.includes("1") || !capabilities["desktop-interaction"]?.includes("1")) return false
    const [dashboard, interactions] = await Promise.all([
      client.request("session/dashboard", {}, 2_500) as Promise<{ sessions?: unknown; active?: unknown; listingUnavailable?: unknown } | null>,
      client.request("desktop/interaction/pending", {}, 2_500),
    ])
    if (!Array.isArray(interactions) || interactions.length || !Array.isArray(dashboard?.sessions)) return false
    if (dashboard.listingUnavailable !== undefined && dashboard.listingUnavailable !== false) return false
    if (dashboard.active !== undefined && dashboard.active !== false) return false
    return dashboard.sessions.every(row => {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || typeof row.live !== "boolean") return false
      if (row.active !== undefined && row.active !== false) return false
      if ((row.live || row.running !== undefined) && row.running !== false) return false
      return (row.queued === undefined || row.queued === 0) && (row.tasks === undefined || row.tasks === 0)
    })
  } catch { return false }
}

export function createWorkspaceRuntimeManager(options: {
  sessionsRoot: string
  resourcesPath?: string
  projectContexts?: () => Promise<DesktopProjectContext[]>
  launch?: (workspace: WorkspaceEntry, sessionDir: string) => LaunchedRuntime
}): WorkspaceRuntimeManager {
  const shared = options.launch ? undefined : createSharedDesktopHost(options.sessionsRoot, options.resourcesPath)
  const needsProjectScope = (id: string) => !!options.projectContexts && (!shared || id !== DESKTOP_CONFIGURATION_ID)
  const listeners = new Set<(event: DesktopEvent) => void>()
  const runtimes = new Map<string, WorkspaceRuntime>()
  const pending = new Map<string, Promise<WorkspaceRuntime>>()
  const children = new Map<string, LaunchedRuntime>()
  // Routing can be withdrawn before shutdown. Only the original release receipt
  // releases ownership of the workspace's session directory.
  const workspaceOwners = new Map<string, LaunchedRuntime>()
  const generations = new Map<string, number>()
  type RecoveryState = { count: number; since: number; retryAt: number; timer?: NodeJS.Timeout }
  const restartWindow = new Map<string, RecoveryState>()
  const healthTimers = new Map<string, NodeJS.Timeout>()
  // A new receipt also distinguishes two accesses in the same millisecond.
  const lastUsed = new Map<string, { at: number }>()
  const idleChecks = new Set<WorkspaceRuntime>()
  const closingClients = new WeakMap<HarnessClient, Promise<void>>()
  const retiredClients = new WeakSet<HarnessClient>()
  let closed = false
  let closeFlight: Promise<void> | undefined
  let activityVersion = 0
  let lookupVersion = 0
  let scopeEpoch = 0
  let scopeSyncTail: Promise<void> = Promise.resolve()

  function touch(id: string): void {
    lastUsed.set(id, { at: Date.now() })
  }

  function closeClient(client: HarnessClient): Promise<void> {
    let closing = closingClients.get(client)
    if (!closing) {
      retiredClients.add(client)
      closing = Promise.resolve().then(() => client.close())
      closingClients.set(client, closing)
      // A shared host retains failed scope cleanup for an explicit retry.
      // Legacy clients keep their original OS termination receipt.
      if (shared) void closing.catch(() => { if (closingClients.get(client) === closing) closingClients.delete(client) })
    }
    return closing
  }

  async function stopWorkspace(launched: LaunchedRuntime): Promise<void> {
    await closeClient(launched.client)
    await launched.exited
  }

  function assertCurrent(id: string, generation: number): void {
    if (closed) throw new Error("runtime manager is closed")
    if ((generations.get(id) ?? 0) !== generation) throw new Error("runtime startup was invalidated")
  }

  function emit(event: DesktopEvent): void {
    if ('workspaceId' in event && typeof event.workspaceId === 'string') touch(event.workspaceId)
    activityVersion++
    const failures:unknown[]=[]
    for (const listener of [...listeners]) {
      if(event.kind!=='sdk/ready'&&event.kind!=='sdk/disconnected'&&(event.kind!=='sdk/notification'||event.method!=='desktop/surface/changed')){listener(event);continue}
      try{listener(event)}catch(error){failures.push(error)}
    }
    if(failures.length)throw new AggregateError(failures,'Surface forwarding failed')
  }

  async function start(workspace: WorkspaceEntry, generation: number): Promise<WorkspaceRuntime> {
    const sessionDir = join(options.sessionsRoot, workspace.id)
    await mkdir(shared ? options.sessionsRoot : sessionDir, { recursive: true })
    assertCurrent(workspace.id, generation)
    const preceding = workspaceOwners.get(workspace.id)
    if (preceding !== undefined) {
      await stopWorkspace(preceding)
      assertCurrent(workspace.id, generation)
    }
    const launched = options.launch ? options.launch(workspace, sessionDir) : await shared!.launch(workspace)
    workspaceOwners.set(workspace.id, launched)
    void launched.exited.then(() => {
      if (workspaceOwners.get(workspace.id) === launched) workspaceOwners.delete(workspace.id)
    })
    touch(workspace.id)
    children.set(workspace.id, launched)
    try {
      assertCurrent(workspace.id, generation)
      if (launched.ready) { await launched.ready; assertCurrent(workspace.id, generation) }
      const info = await launched.client.initialize()
      assertCurrent(workspace.id, generation)
      if (info.protocolVersion !== 3) {
        throw new Error(`unsupported SDK protocol ${info.protocolVersion}; Desktop speaks version 3`)
      }
      const sandbox = info.capabilities["desktop-sandbox"]?.includes("1")
        ? validateSandboxState(await launched.client.request("desktop/sandbox/state", {}))
        : undefined
      if (needsProjectScope(workspace.id)) {
        if (!info.capabilities["desktop-project-scope"]?.includes("1")) throw new Error("Gateway does not support project execution scopes")
      }
      launched.client.onNotification((frame) => {
        if (closed || (generations.get(workspace.id) ?? 0) !== generation || children.get(workspace.id) !== launched) return
        if (frame.method === "desktop/gateway/fatal") {
          const params = frame.params as { message?: unknown; diagnostic?: unknown } | undefined
          launched.fatal = [typeof params?.message === "string" ? params.message : "Gateway fatal error", typeof params?.diagnostic === "string" ? params.diagnostic : ""].filter(Boolean).join("\n").slice(0, 8192)
          return
        }
        // One lookup derived from the shared method list; bridge.ts asserts at
        // compile time that every DesktopNotificationMethod is listed there, so
        // a new notification cannot be silently dropped by a stale chain.
        if (!isForwardedNotification(frame.method)) return
        const params = frame.method === "desktop/context/diagnostic" && frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? { ...frame.params, runtimeGeneration: generation } : frame.params
        emit({ kind: "sdk/notification", workspaceId: workspace.id, method: frame.method, params })
      },()=>{void manager.invalidate!(workspace.id).catch(()=>{})})
      return { client: launched.client, info, sandbox, hostPid: launched.hostPid, whenClosed: () => {
        const closing=closingClients.get(launched.client)
        return closing ? closing.then(()=>launched.exited,()=>launched.exited) : children.get(workspace.id)!==launched ? launched.exited : undefined
      } }
    } catch (error) {
      if (children.get(workspace.id) === launched) children.delete(workspace.id)
      await stopWorkspace(launched).catch(() => undefined)
      throw error
    }
  }

  function recoveryState(id: string) {
    const state = restartWindow.get(id)
    if (state && Date.now() - state.since <= 60_000) return state
    if (state?.timer) clearTimeout(state.timer)
    restartWindow.delete(id)
    return undefined
  }
  function scheduleRecovery(workspace: WorkspaceEntry, generation: number): void {
    if (closed || (generations.get(workspace.id) ?? 0) !== generation) return
    const now = Date.now()
    const state: RecoveryState = recoveryState(workspace.id) ?? { count: 0, since: now, retryAt: now }
    if (state.timer) clearTimeout(state.timer)
    state.count += 1
    state.retryAt = now + 500 * state.count
    restartWindow.set(workspace.id, state)
    if (state.count >= 4) return
    const attempt = state.count
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (recoveryState(workspace.id) !== state || state.count !== attempt) return
      if (closed || (generations.get(workspace.id) ?? 0) !== generation || runtimes.has(workspace.id) || pending.has(workspace.id)) return
      void manager.get(workspace).catch(() => { /* The manager owns the next bounded retry. */ })
    }, state.retryAt - now)
  }
  const manager: WorkspaceRuntimeManager = {
    async recover(workspace) {
      await manager.invalidate!(workspace.id)
      const timer = restartWindow.get(workspace.id)?.timer
      if (timer) clearTimeout(timer)
      restartWindow.delete(workspace.id)
      return manager.get(workspace)
    },
    peek(id) {
      const runtime = runtimes.get(id)
      return runtime && !retiredClients.has(runtime.client) ? runtime : undefined
    },
    pendingRuntime: (id) => pending.get(id),
    async invalidate(id) {
      const runtime = runtimes.get(id)
      const starting = pending.get(id)
      const child = workspaceOwners.get(id)
      if (!runtime && !starting && !child) return
      const generation = generations.get(id) ?? 0
      const health = healthTimers.get(id)
      if (health !== undefined) { clearInterval(health); healthTimers.delete(id) }
      generations.set(id, generation + 1)
      runtimes.delete(id)
      pending.delete(id)
      children.delete(id)
      try {emit({ kind: "sdk/disconnected", workspaceId: id, message: "Project execution scope changed; reconnect to continue.", close: { generation, reason: "scope-changed" } })} catch { /* The original generation is fenced; failed forwarding cannot skip child cleanup. */ }
      try {
        if (child) await stopWorkspace(child)
        else if (runtime) await closeClient(runtime.client)
      } finally {
        if (starting) await starting.catch(() => undefined)
      }
    },
    refreshProjectContexts() {
      if (closed) return Promise.reject(new Error("runtime manager is closed"))
      // Increment synchronously: even a startup already awaiting an old sync
      // must observe this fence before it can publish a ready runtime.
      scopeEpoch += 1
      activityVersion += 1
      const refreshing = scopeSyncTail.then(async () => {
        if (closed) throw new Error("runtime manager is closed")
        await Promise.allSettled([...pending.values()])
        if (closed) throw new Error("runtime manager is closed")
        if (!options.projectContexts) return
        const projects = await options.projectContexts()
        if (closed) throw new Error("runtime manager is closed")
        const outcomes = await Promise.allSettled([...runtimes.entries()].map(async ([id, runtime]) => {
          if (!needsProjectScope(id)) return
          try { await runtime.client.request("desktop/project/sync", { projects }) }
          catch (error) {
            // A concurrent replacement owns its own lifecycle.
            if (runtimes.get(id) === runtime) await manager.invalidate!(id)
            throw error
          }
        }))
        const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Project scope update failed; affected Agent runtimes were closed. Retry to apply the current folder settings.")
      })
      // Serialize publications and allow retry after a failed publication.
      scopeSyncTail = refreshing.catch(() => undefined)
      return refreshing
    },
    get(workspace) {
      if (closed) return Promise.reject(new Error("runtime manager is closed"))
      touch(workspace.id)
      lookupVersion++
      const ready = runtimes.get(workspace.id)
      if (ready !== undefined) return retiredClients.has(ready.client) ? Promise.reject(new Error("Gateway recovery is pending.")) : Promise.resolve(ready)
      const inflight = pending.get(workspace.id)
      if (inflight !== undefined) return inflight
      const recovery = recoveryState(workspace.id)
      if (recovery && (recovery.count >= 4 || Date.now() < recovery.retryAt)) {
        return Promise.reject(new Error(recovery.count >= 4 ? 'Gateway recovery limit reached. Use Reconnect to try again.' : 'Gateway recovery is pending.'))
      }
      const generation = generations.get(workspace.id) ?? 0
      const started: Promise<WorkspaceRuntime> = start(workspace, generation)
        .then(async (runtime) => {
          try {
            assertCurrent(workspace.id, generation)
            if (options.projectContexts && needsProjectScope(workspace.id)) {
              let syncedEpoch: number
              do {
                syncedEpoch = scopeEpoch
                const projects = await options.projectContexts()
                assertCurrent(workspace.id, generation)
                await runtime.client.request("desktop/project/sync", { projects })
                assertCurrent(workspace.id, generation)
              } while (syncedEpoch !== scopeEpoch)
            }
          } catch (error) {
            if (children.get(workspace.id)?.client === runtime.client) children.delete(workspace.id)
            await closeClient(runtime.client).catch(() => undefined)
            throw error
          }
          // No await between checking the epoch/generation and publication.
          runtimes.set(workspace.id, runtime)
          // Successful initialization does not erase a recent crash loop.
          let healthMisses = 0
          if (!shared) {
            const health = setInterval(() => {
              if (closed || (generations.get(workspace.id) ?? 0) !== generation || runtimes.get(workspace.id) !== runtime) return
              void runtime.client.request("ping", {}, 10_000).then(() => { healthMisses = 0 }, () => {
                if (closed || runtimes.get(workspace.id) !== runtime || healthTimers.get(workspace.id) !== health) return
                if (++healthMisses < 2) return
                clearInterval(health)
                healthTimers.delete(workspace.id)
                // Withdraw routing before listeners can try to use the dying host.
                void closeClient(runtime.client).catch(() => undefined)
                try { emit({ kind: "sdk/disconnected", workspaceId: workspace.id, message: "Gateway health check failed twice; restarting.", close: { generation, reason: "unhealthy" } }) }
                catch { /* View delivery cannot prevent process recovery. */ }
              })
            }, 20_000)
            health.unref()
            healthTimers.set(workspace.id, health)
          }
          try {emit({kind:'sdk/ready',method:'sdk/ready',workspaceId:workspace.id,runtimeGeneration:generation})} catch(error) {void manager.invalidate!(workspace.id).catch(()=>{});throw error}
          activityVersion += 1
          const launched = children.get(workspace.id)
          if (launched !== undefined) {
            void (launched.disconnected ?? launched.exited).then(() => {
              if (runtimes.get(workspace.id)?.client !== runtime.client) return
              runtimes.delete(workspace.id)
              children.delete(workspace.id)
              const healthTimer = healthTimers.get(workspace.id)
              if (healthTimer !== undefined) { clearInterval(healthTimer); healthTimers.delete(workspace.id) }
              const exit = launched.exitInfo?.() ?? { code: null, signal: null }
              const tail = launched.stderrTail?.().trim()
              const fatal = launched.fatal?.trim()
              const detail = `SDK subprocess exited (code ${exit.code ?? "?"}${exit.signal ? `, signal ${exit.signal}` : ""})${fatal ? `: ${fatal}` : tail ? `: ${tail.slice(-1800)}` : ""}`
              if (closed || (generations.get(workspace.id) ?? 0) !== generation) return
              generations.set(workspace.id, generation + 1)
              scheduleRecovery(workspace, generation + 1)
              if (healthMisses < 2) {
                try { emit({ kind: "sdk/disconnected", workspaceId: workspace.id, message: detail, close: { generation, reason: "subprocess-exited", ...(typeof exit.code === "number" ? { code: exit.code } : {}), ...(typeof exit.signal === "string" ? { signal: exit.signal } : {}), ...(tail ? { stderr: tail.slice(-1800) } : {}) } }) }
                catch { /* View delivery cannot prevent process recovery. */ }
              }
            })
          }
          return runtime
        })
        .catch(error => {
          if (!closed && (generations.get(workspace.id) ?? 0) === generation) {
            generations.set(workspace.id, generation + 1)
            scheduleRecovery(workspace, generation + 1)
            try { emit({ kind: 'sdk/disconnected', workspaceId: workspace.id, message: error instanceof Error ? error.message : String(error), close: { generation, reason: 'initialization-failed' } }) } catch { /* Keep the original startup failure. */ }
          }
          throw error
        })
        .finally(() => {
          if (pending.get(workspace.id) === started) pending.delete(workspace.id)
        })
      pending.set(workspace.id, started)
      activityVersion += 1
      return started
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async hasActiveWork() {
      if (pending.size > 0) return true
      const activity = activityVersion
      for (let attempt = 0; attempt < 2; attempt++) {
        const lookups = lookupVersion
        const idle = await Promise.all([...runtimes.values()].map(runtimeIsIdle))
        if (idle.includes(false) || pending.size > 0 || activityVersion !== activity) return true
        if (lookups === lookupVersion) return false
        // A renderer read can acquire an existing client just after turn/end.
        // Confirm the new access once. A second overlap keeps the process.
      }
      return true
    },
    async evictIdle(ttlMs) {
      if (closed || ttlMs <= 0) return 0
      const now = Date.now()
      const epoch = scopeEpoch
      const retired = await Promise.all([...runtimes].map(async ([id, runtime]) => {
        const observed = lastUsed.get(id)
        if (!observed || now - observed.at < ttlMs || idleChecks.has(runtime) || closingClients.has(runtime.client)) return false
        idleChecks.add(runtime)
        try {
          if (!await runtimeIsIdle(runtime)) return false
          if (closed || scopeEpoch !== epoch || runtimes.get(id) !== runtime || lastUsed.get(id) !== observed || closingClients.has(runtime.client)) return false
          generations.set(id, (generations.get(id) ?? 0) + 1)
          runtimes.delete(id)
          children.delete(id)
          lastUsed.delete(id)
          const health = healthTimers.get(id)
          if (health !== undefined) { clearInterval(health); healthTimers.delete(id) }
          const child = workspaceOwners.get(id)
          if (child) await stopWorkspace(child)
          return true
        } finally { idleChecks.delete(runtime) }
      }))
      await shared?.retireIfEmpty()
      return retired.filter(Boolean).length
    },
    close() {
      if (closeFlight) return closeFlight
      closed = true
      const flight = Promise.resolve().then(async () => {
        for (const state of restartWindow.values()) if (state.timer) clearTimeout(state.timer)
        restartWindow.clear()
        for (const timer of healthTimers.values()) clearInterval(timer)
        healthTimers.clear()
        const owners = [...workspaceOwners]
        const closingIds = [...new Set([...runtimes.keys(), ...owners.map(([id]) => id)])]
        const starters = [...pending.values()]
        children.clear()
        runtimes.clear()
        pending.clear()
        const stopped = await Promise.allSettled(owners.map(([, child]) => stopWorkspace(child)))
        await Promise.allSettled([...starters, scopeSyncTail])
        const errors = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, "Gateway shutdown incomplete")
        await shared?.close()
        for (const id of closingIds) { try { emit({ kind: "sdk/disconnected", workspaceId: id, message: "Runtime manager closed.", close: { generation: generations.get(id) ?? 0, reason: "manager-closed" } }) } catch { /* Diagnostics cannot fail owner close. */ } }
        listeners.clear()
      })
      closeFlight = flight
      void flight.catch(() => { if (closeFlight === flight) closeFlight = undefined })
      return flight
    },
  }
  return manager
}
