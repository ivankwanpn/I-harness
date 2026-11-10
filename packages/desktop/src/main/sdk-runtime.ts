import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HarnessClient, type ServerInfo } from "@i-harness/sdk"
import { DESKTOP_NOTIFICATION_METHODS, type DesktopEvent, type DesktopNotificationMethod } from "../shared/bridge.ts"

const FORWARDED_NOTIFICATIONS = new Set<DesktopNotificationMethod>(DESKTOP_NOTIFICATION_METHODS)
function isForwardedNotification(method: string): method is DesktopNotificationMethod { return FORWARDED_NOTIFICATIONS.has(method as DesktopNotificationMethod) }
import type { WorkspaceEntry } from "./workspaces.ts"
import type { DesktopProjectContext } from "./project-runtime.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface WorkspaceRuntime {
  client: HarnessClient
  info: ServerInfo
  sandbox?: SandboxState
  /** Exact original connection cleanup/exit receipt; never a replacement runtime. */
  whenClosed?(): Promise<void> | undefined
}

export interface LaunchedRuntime {
  client: HarnessClient
  /** Resolves when the SDK subprocess is gone (exit or spawn failure). */
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

/**
 * D0 launcher: the bundled SDK client drives the approved local gateway CLI
 * over stdio. Electron runs its own binary as Node for the child so the
 * development source (tsx loader + gateway entry) loads without a build.
 */
export function launchLocalGateway(workspace: WorkspaceEntry, sessionDir: string): LaunchedRuntime {
  const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)))
  const tsxLoader = pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href
  const gatewayEntry = join(repoRoot, "packages", "desktop-gateway", "src", "cli.ts")
  const child = spawn(process.execPath, ["--import", tsxLoader, gatewayEntry, "--session-dir", sessionDir], {
    cwd: workspace.path,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const stderrTail = captureChildStream(child.stderr)
  let exitInfo: { code: number | null; signal: string | null } | undefined
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", (code, signal) => { exitInfo = { code, signal }; resolveExit() })
    child.once("error", () => { if (child.pid === undefined) { exitInfo = { code: null, signal: null }; resolveExit() } })
  })
  return { client: new HarnessClient(child.stdout, child.stdin, { child }), exited, stderrTail, exitInfo: () => exitInfo }
}

/**
 * Packaged launcher: the same tsx + source-tree startup the e2e tests
 * exercise, but rooted in `<resources>/gateway` instead of the repo checkout.
 */
export function launchBundledGateway(
  resourcesPath: string,
  workspace: WorkspaceEntry,
  sessionDir: string,
): LaunchedRuntime {
  const gatewayRoot = join(resourcesPath, "gateway")
  const gatewayEntry = join(gatewayRoot, "cli", "src", "cli.js")
  const child = spawn(process.execPath, [gatewayEntry, "--session-dir", sessionDir], {
    cwd: workspace.path,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const stderrTail = captureChildStream(child.stderr)
  let exitInfo: { code: number | null; signal: string | null } | undefined
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", (code, signal) => { exitInfo = { code, signal }; resolveExit() })
    child.once("error", () => { if (child.pid === undefined) { exitInfo = { code: null, signal: null }; resolveExit() } })
  })
  return { client: new HarnessClient(child.stdout, child.stdin, { child }), exited, stderrTail, exitInfo: () => exitInfo }
}

export function createWorkspaceRuntimeManager(options: {
  sessionsRoot: string
  projectContexts?: () => Promise<DesktopProjectContext[]>
  launch?: (workspace: WorkspaceEntry, sessionDir: string) => LaunchedRuntime
}): WorkspaceRuntimeManager {
  const launch = options.launch ?? launchLocalGateway
  const listeners = new Set<(event: DesktopEvent) => void>()
  const runtimes = new Map<string, WorkspaceRuntime>()
  const pending = new Map<string, Promise<WorkspaceRuntime>>()
  const children = new Map<string, LaunchedRuntime>()
  const generations = new Map<string, number>()
  type RecoveryState = { count: number; since: number; retryAt: number; timer?: NodeJS.Timeout }
  const restartWindow = new Map<string, RecoveryState>()
  const healthTimers = new Map<string, NodeJS.Timeout>()
  const healthFailures = new Map<string, number>()
  const lastUsed = new Map<string, number>()
  const closingClients = new WeakMap<HarnessClient, Promise<void>>()
  let closed = false
  let activityVersion = 0
  let scopeEpoch = 0
  let scopeSyncTail: Promise<void> = Promise.resolve()

  function closeClient(client: HarnessClient): Promise<void> {
    let closing = closingClients.get(client)
    if (!closing) {
      closing = client.close().catch(() => undefined)
      closingClients.set(client, closing)
    }
    return closing
  }

  function assertCurrent(id: string, generation: number): void {
    if (closed) throw new Error("runtime manager is closed")
    if ((generations.get(id) ?? 0) !== generation) throw new Error("runtime startup was invalidated")
  }

  function emit(event: DesktopEvent): void {
    if ('workspaceId' in event && typeof event.workspaceId === 'string') lastUsed.set(event.workspaceId, Date.now())
    activityVersion += 1
    const failures:unknown[]=[]
    for (const listener of [...listeners]) {
      if(event.kind!=='sdk/ready'&&event.kind!=='sdk/disconnected'&&(event.kind!=='sdk/notification'||event.method!=='desktop/surface/changed')){listener(event);continue}
      try{listener(event)}catch(error){failures.push(error)}
    }
    if(failures.length)throw new AggregateError(failures,'Surface forwarding failed')
  }

  async function start(workspace: WorkspaceEntry, generation: number): Promise<WorkspaceRuntime> {
    const sessionDir = join(options.sessionsRoot, workspace.id)
    await mkdir(sessionDir, { recursive: true })
    assertCurrent(workspace.id, generation)
    const launched = launch(workspace, sessionDir)
    lastUsed.set(workspace.id, Date.now())
    children.set(workspace.id, launched)
    try {
      const info = await launched.client.initialize()
      assertCurrent(workspace.id, generation)
      if (info.protocolVersion !== 3) {
        throw new Error(`unsupported SDK protocol ${info.protocolVersion}; Desktop speaks version 3`)
      }
      const sandbox = info.capabilities["desktop-sandbox"]?.includes("1")
        ? validateSandboxState(await launched.client.request("desktop/sandbox/state", {}))
        : undefined
      if (options.projectContexts) {
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
      return { client: launched.client, info, sandbox, whenClosed: () => {
        const closing=closingClients.get(launched.client)
        return closing ? closing.then(()=>launched.exited) : children.get(workspace.id)!==launched ? launched.exited : undefined
      } }
    } catch (error) {
      if (children.get(workspace.id) === launched) children.delete(workspace.id)
      await closeClient(launched.client)
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
    peek: (id) => runtimes.get(id),
    async invalidate(id) {
      const runtime = runtimes.get(id)
      const starting = pending.get(id)
      const child = children.get(id)
      if (!runtime && !starting && !child) return
      const generation = generations.get(id) ?? 0
      const health = healthTimers.get(id)
      if (health !== undefined) { clearInterval(health); healthTimers.delete(id) }
      healthFailures.delete(id)
      generations.set(id, generation + 1)
      runtimes.delete(id)
      pending.delete(id)
      children.delete(id)
      try {emit({ kind: "sdk/disconnected", workspaceId: id, message: "Project execution scope changed; reconnect to continue.", close: { generation, reason: "scope-changed" } })} catch { /* The original generation is fenced; failed forwarding cannot skip child cleanup. */ }
      const client = child?.client ?? runtime?.client
      if (client) await closeClient(client)
      if (starting) await starting.catch(() => undefined)
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
      lastUsed.set(workspace.id, Date.now())
      const ready = runtimes.get(workspace.id)
      if (ready !== undefined) return Promise.resolve(ready)
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
            if (options.projectContexts) {
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
            await closeClient(runtime.client)
            throw error
          }
          // No await between checking the epoch/generation and publication.
          runtimes.set(workspace.id, runtime)
          // Successful initialization does not erase a recent crash loop.
          const health = setInterval(() => {
            if (closed || (generations.get(workspace.id) ?? 0) !== generation || runtimes.get(workspace.id) !== runtime) return
            let timeout: NodeJS.Timeout | undefined
            void Promise.race([
              runtime.client.request("ping", {}).then(() => true, () => false),
              // A busy model stream can delay the event loop; one slow ping is
              // not a dead gateway. Give it a generous single probe and only
              // restart after two consecutive misses.
              new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 10_000); timeout.unref() }),
            ]).then((ok) => {
              if (timeout !== undefined) clearTimeout(timeout)
              if (closed || runtimes.get(workspace.id) !== runtime) return
              if (ok) { healthFailures.delete(workspace.id); return }
              if (healthTimers.get(workspace.id) !== health) return
              const misses = (healthFailures.get(workspace.id) ?? 0) + 1
              healthFailures.set(workspace.id, misses)
              if (misses < 2) return
              clearInterval(health)
              healthTimers.delete(workspace.id)
              healthFailures.delete(workspace.id)
              emit({ kind: "sdk/disconnected", workspaceId: workspace.id, message: "Gateway health check failed twice; restarting.", close: { generation, reason: "unhealthy" } })
              void runtime.client.close().catch(() => undefined)
            })
          }, 20_000)
          health.unref()
          healthTimers.set(workspace.id, health)
          try {emit({kind:'sdk/ready',method:'sdk/ready',workspaceId:workspace.id,runtimeGeneration:generation})} catch(error) {void manager.invalidate!(workspace.id).catch(()=>{});throw error}
          activityVersion += 1
          const launched = children.get(workspace.id)
          if (launched !== undefined) {
            void launched.exited.then(() => {
              if (runtimes.get(workspace.id)?.client !== runtime.client) return
              runtimes.delete(workspace.id)
              children.delete(workspace.id)
              const healthTimer = healthTimers.get(workspace.id)
              if (healthTimer !== undefined) { clearInterval(healthTimer); healthTimers.delete(workspace.id) }
              const exit = launched.exitInfo?.() ?? { code: null, signal: null }
              const tail = launched.stderrTail?.().trim()
              const fatal = launched.fatal?.trim()
              const detail = `SDK subprocess exited (code ${exit.code ?? "?"}${exit.signal ? `, signal ${exit.signal}` : ""})${fatal ? `: ${fatal}` : tail ? `: ${tail.slice(-1800)}` : ""}`
              if (!closed) emit({ kind: "sdk/disconnected", workspaceId: workspace.id, message: detail, close: { generation, reason: "subprocess-exited", ...(typeof exit.code === "number" ? { code: exit.code } : {}), ...(typeof exit.signal === "string" ? { signal: exit.signal } : {}), ...(tail ? { stderr: tail.slice(-1800) } : {}) } })
              // Own the recovery here instead of leaving the renderer on a
              // dead transport until the user discovers Reconnect. A bounded
              // restart window prevents a crash loop from spawning forever.
              if (closed || (generations.get(workspace.id) ?? 0) !== generation) return
              scheduleRecovery(workspace, generation)
            })
          }
          return runtime
        })
        .catch(error => {
          if (!closed && (generations.get(workspace.id) ?? 0) === generation) {
            scheduleRecovery(workspace, generation)
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
      if (runtimes.size === 0) return false
      const version = activityVersion
      const results = await Promise.all([...runtimes.values()].map(async (runtime) => {
        const capabilities = runtime.info.capabilities
        if (!capabilities["session-dashboard"]?.includes("1") || !capabilities["desktop-interaction"]?.includes("1")) return true
        try {
          const [dashboard, interactions] = await Promise.all([
            runtime.client.request("session/dashboard", {}, 2_500),
            runtime.client.request("desktop/interaction/pending", {}, 2_500),
          ])
          if (!dashboard || typeof dashboard !== "object" || !Array.isArray((dashboard as { sessions?: unknown }).sessions)
            || (dashboard as { listingUnavailable?: unknown }).listingUnavailable === true || !Array.isArray(interactions)) return true
          if (interactions.length > 0) return true
          if ((dashboard as { active?: unknown }).active === true) return true
          if ((dashboard as { active?: unknown }).active !== undefined && typeof (dashboard as { active?: unknown }).active !== 'boolean') return true
          for (const row of (dashboard as { sessions: unknown[] }).sessions) {
            if (!row || typeof row !== "object") return true
            const value = row as Record<string, unknown>
            if (typeof value.id !== "string" || value.id === "") return true
            if (typeof value.live !== "boolean" || value.live && typeof value.running !== "boolean") return true
            if (value.running === true) return true
            if (value.active === true) return true
            if (value.active !== undefined && typeof value.active !== 'boolean') return true
            if (value.running !== undefined && typeof value.running !== "boolean") return true
            for (const field of ["queued", "tasks"] as const) {
              const count = value[field]
              if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) return true
              if ((count as number | undefined) !== undefined && (count as number) > 0) return true
            }
          }
          return false
        } catch { return true }
      }))
      return results.some(Boolean) || pending.size > 0 || activityVersion !== version
    },
    async evictIdle(ttlMs) {
      if (closed || ttlMs <= 0) return 0
      const now = Date.now()
      let retired = 0
      for (const [id, runtime] of [...runtimes]) {
        if (now - (lastUsed.get(id) ?? 0) < ttlMs) continue
        const checkedVersion = activityVersion
        const checkedLastUsed = lastUsed.get(id)
        try {
          const dashboard = await runtime.client.request("session/dashboard", {}, 2_500) as { sessions?: unknown }
          if (!dashboard || typeof dashboard !== "object" || !Array.isArray(dashboard.sessions) || (dashboard as { listingUnavailable?: unknown }).listingUnavailable === true) continue
          if ((dashboard as { active?: unknown }).active === true) continue
          if ((dashboard as { active?: unknown }).active !== undefined && typeof (dashboard as { active?: unknown }).active !== 'boolean') continue
          const busy = dashboard.sessions.some(row => {
            if (!row || typeof row !== "object") return true
            const value = row as Record<string, unknown>
            if (typeof value.id !== 'string' || typeof value.live !== 'boolean' || (value.live && typeof value.running !== 'boolean') || (value.active !== undefined && typeof value.active !== 'boolean')) return true
            return value.active === true || value.running === true || Number(value.queued ?? 0) > 0 || Number(value.tasks ?? 0) > 0
          })
          if (busy) continue
          const interactions = await runtime.client.request("desktop/interaction/pending", {}, 2_500)
          if (!Array.isArray(interactions) || interactions.length > 0) continue
        } catch { continue }
        if (closed || runtimes.get(id) !== runtime || activityVersion !== checkedVersion || lastUsed.get(id) !== checkedLastUsed || pending.has(id)) continue
        generations.set(id, (generations.get(id) ?? 0) + 1)
        runtimes.delete(id)
        children.delete(id)
        lastUsed.delete(id)
        const health = healthTimers.get(id)
        if (health !== undefined) { clearInterval(health); healthTimers.delete(id) }
        healthFailures.delete(id)
        await closeClient(runtime.client)
        retired += 1
      }
      return retired
    },
    async close() {
      if (closed) return
      closed = true
      for (const state of restartWindow.values()) if (state.timer) clearTimeout(state.timer)
      restartWindow.clear()
      for (const timer of healthTimers.values()) clearInterval(timer)
      healthTimers.clear()
      const closingIds = [...new Set([...runtimes.keys(), ...children.keys()])]
      const clients = [...children.values()].map((launched) => launched.client)
      const starters = [...pending.values()]
      children.clear()
      runtimes.clear()
      pending.clear()
      await Promise.allSettled(clients.map(closeClient))
      await Promise.allSettled([...starters, scopeSyncTail])
      for (const id of closingIds) { try { emit({ kind: "sdk/disconnected", workspaceId: id, message: "Runtime manager closed.", close: { generation: generations.get(id) ?? 0, reason: "manager-closed" } }) } catch { /* Diagnostics cannot fail owner close. */ } }
      listeners.clear()
    },
  }
  return manager
}
