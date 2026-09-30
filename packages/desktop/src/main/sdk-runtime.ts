import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HarnessClient, type ServerInfo } from "@i-harness/sdk"
import type { DesktopEvent } from "../shared/bridge.ts"
import type { WorkspaceEntry } from "./workspaces.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface WorkspaceRuntime {
  client: HarnessClient
  info: ServerInfo
  sandbox?: SandboxState
}

export interface LaunchedRuntime {
  client: HarnessClient
  /** Resolves when the SDK subprocess is gone (exit or spawn failure). */
  exited: Promise<void>
}

/** A child that writes more than the pipe buffer holds would block forever if
 * nobody reads that stream; its diagnostics are not a protocol channel. */
export function drainChildStream(stream: NodeJS.ReadableStream | null | undefined): void {
  stream?.resume()
}

export interface WorkspaceRuntimeManager {
  get(workspace: WorkspaceEntry): Promise<WorkspaceRuntime>
  onEvent(listener: (event: DesktopEvent) => void): () => void
  /** Close-time SDK query. Unknown state retains the process. */
  hasActiveWork(): Promise<boolean>
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
  drainChildStream(child.stderr)
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit())
    child.once("error", () => resolveExit())
  })
  return { client: new HarnessClient(child.stdout, child.stdin, { child }), exited }
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
  const tsxLoader = pathToFileURL(join(gatewayRoot, "node_modules", "tsx", "dist", "loader.mjs")).href
  const gatewayEntry = join(gatewayRoot, "cli", "src", "cli.ts")
  const child = spawn(process.execPath, ["--import", tsxLoader, gatewayEntry, "--session-dir", sessionDir], {
    cwd: workspace.path,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  drainChildStream(child.stderr)
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit())
    child.once("error", () => resolveExit())
  })
  return { client: new HarnessClient(child.stdout, child.stdin, { child }), exited }
}

export function createWorkspaceRuntimeManager(options: {
  sessionsRoot: string
  launch?: (workspace: WorkspaceEntry, sessionDir: string) => LaunchedRuntime
}): WorkspaceRuntimeManager {
  const launch = options.launch ?? launchLocalGateway
  const listeners = new Set<(event: DesktopEvent) => void>()
  const runtimes = new Map<string, WorkspaceRuntime>()
  const pending = new Map<string, Promise<WorkspaceRuntime>>()
  const children = new Map<string, LaunchedRuntime>()
  let closed = false
  let activityVersion = 0

  function emit(event: DesktopEvent): void {
    activityVersion += 1
    for (const listener of [...listeners]) listener(event)
  }

  async function start(workspace: WorkspaceEntry): Promise<WorkspaceRuntime> {
    const sessionDir = join(options.sessionsRoot, workspace.id)
    await mkdir(sessionDir, { recursive: true })
    const launched = launch(workspace, sessionDir)
    children.set(workspace.id, launched)
    try {
      const info = await launched.client.initialize()
      if (info.protocolVersion !== 3) {
        throw new Error(`unsupported SDK protocol ${info.protocolVersion}; Desktop speaks version 3`)
      }
      const sandbox = info.capabilities["desktop-sandbox"]?.includes("1")
        ? validateSandboxState(await launched.client.request("desktop/sandbox/state", {}))
        : undefined
      launched.client.onNotification((frame) => {
        if (frame.method !== "session/event"
          && frame.method !== "session/status"
          && frame.method !== "desktop/interaction/request"
          && frame.method !== "desktop/interaction/closed"
          && frame.method !== "desktop/workflow/changed") return
        emit({ kind: "sdk/notification", workspaceId: workspace.id, method: frame.method, params: frame.params })
      })
      return { client: launched.client, info, sandbox }
    } catch (error) {
      children.delete(workspace.id)
      await launched.client.close().catch(() => undefined)
      throw error
    }
  }

  return {
    get(workspace) {
      const ready = runtimes.get(workspace.id)
      if (ready !== undefined) return Promise.resolve(ready)
      const inflight = pending.get(workspace.id)
      if (inflight !== undefined) return inflight
      const started: Promise<WorkspaceRuntime> = start(workspace)
        .then(async (runtime) => {
          if (closed) {
            await runtime.client.close().catch(() => undefined)
            throw new Error("runtime manager is closed")
          }
          runtimes.set(workspace.id, runtime)
          activityVersion += 1
          const launched = children.get(workspace.id)
          if (launched !== undefined) {
            void launched.exited.then(() => {
              if (runtimes.get(workspace.id)?.client !== runtime.client) return
              runtimes.delete(workspace.id)
              children.delete(workspace.id)
              if (!closed) emit({ kind: "sdk/disconnected", workspaceId: workspace.id, message: "SDK subprocess exited" })
            })
          }
          return runtime
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
          for (const row of (dashboard as { sessions: unknown[] }).sessions) {
            if (!row || typeof row !== "object") return true
            const value = row as Record<string, unknown>
            if (typeof value.id !== "string" || value.id === "") return true
            if (typeof value.live !== "boolean" || value.live && typeof value.running !== "boolean") return true
            if (value.running === true) return true
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
    async close() {
      if (closed) return
      closed = true
      listeners.clear()
      const clients = [...children.values()].map((launched) => launched.client)
      children.clear()
      runtimes.clear()
      pending.clear()
      await Promise.allSettled(clients.map((client) => client.close()))
    },
  }
}
