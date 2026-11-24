import { mkdir, readdir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { decodeFrame, isRpcRequest } from "@i-harness/sdk"
import type { DesktopHost, DesktopHostOptions } from "./host.ts"
import { DesktopHostStartupError } from "./host-startup-error.ts"
import { DESKTOP_CONFIGURATION_ID, type DesktopHostEvent } from "./host-protocol.ts"

interface Scope {
  id: string
  workspace: string
  ready: Promise<DesktopHost>
  host?: DesktopHost
  handshake?: Promise<void>
  active: Set<Promise<void>>
  retiring: boolean
  closeFlight?: Promise<void>
  startupCleanup?: () => Promise<void>
}

const fileKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createWorkspaceHosts(
  sessionsRoot: string,
  create: (options: DesktopHostOptions) => Promise<DesktopHost>,
  send: (event: DesktopHostEvent) => void,
) {
  const scopes = new Map<string, Scope>()
  let stopping = false
  function retire(scope: Scope): Promise<void> {
    scope.retiring = true
    if (scope.closeFlight) return scope.closeFlight
    const flight = (async () => {
      const host = await scope.ready.catch(() => undefined)
      await host?.close()
      await scope.startupCleanup?.()
      await Promise.allSettled([...scope.active])
      scopes.delete(fileKey(scope.id))
    })()
    scope.closeFlight = flight
    void flight.catch(() => { scope.closeFlight = undefined })
    return flight
  }
  async function open(id: string, workspace: string) {
    const key = fileKey(id)
    const existing = scopes.get(key)
    if (existing && (existing.id !== id || fileKey(existing.workspace) !== fileKey(workspace) || existing.closeFlight)) throw Error("Workspace channel already in use")
    if (existing && !existing.startupCleanup) {
      if (existing.retiring) throw Error("Workspace channel already in use")
      if (existing.host) send({ type: "opened", workspaceId: id })
      return
    }
    const sessionDir = join(sessionsRoot, id)
    const ready: Promise<DesktopHost> = Promise.resolve().then(async () => {
      // Transfer a failed construction's remaining handles to this attempt.
      // Its original owners must finish closing before a replacement opens.
      if (existing?.startupCleanup) {
        try { await existing.startupCleanup() }
        catch (error) { scope.startupCleanup = existing.startupCleanup; throw error }
      }
      const canonical = await realpath(workspace)
      if (fileKey(canonical) !== fileKey(workspace) || !(await stat(canonical)).isDirectory()) throw Error("Workspace path changed")
      if (key === fileKey(DESKTOP_CONFIGURATION_ID)) {
        if (id !== DESKTOP_CONFIGURATION_ID || fileKey(canonical) !== fileKey(await realpath(dirname(sessionsRoot)))) throw Error("Invalid desktop configuration scope")
      } else {
        await mkdir(sessionDir, { recursive: true })
        if (process.platform === "win32" && !(await readdir(sessionsRoot)).includes(id)) throw Error("Workspace storage identity mismatch")
        if (fileKey(await realpath(sessionDir)) !== fileKey(join(await realpath(sessionsRoot), id))) throw Error("Workspace session directory changed")
      }
      return create({
        workspace: canonical, sessionDir,
        onWrite: frame => {
          if (scope.host && !scope.retiring && scopes.get(key) === scope) send({ type: "data", workspaceId: id, line: JSON.stringify(frame) })
        },
      })
    }).catch(error => {
      if (error instanceof DesktopHostStartupError) scope.startupCleanup = error.retryCleanup
      throw error
    })
    const scope: Scope = { id, workspace, ready, active: new Set(), retiring: false }
    scopes.set(key, scope)
    try {
      scope.host = await ready
      if (!scope.retiring) send({ type: "opened", workspaceId: id })
    } catch (error) {
      if (!scope.retiring && !scope.startupCleanup && !scope.host) scopes.delete(key)
      throw error
    }
  }
  async function data(scope: Scope, line: string) {
    const host = scope.host
    if (!host || scope.retiring) throw Error("Workspace channel is not open")
    let job: Promise<void>
    if (scope.handshake) job = scope.handshake.then(() => host.handleLine(line))
    else {
      const frame = decodeFrame(line)
      job = host.handleLine(line)
      if (isRpcRequest(frame) && frame.method === "initialize") scope.handshake = job
    }
    scope.active.add(job)
    try { await job }
    catch (error) { if (!scope.retiring) throw error }
    finally { scope.active.delete(job) }
  }
  return {
    async receive(value: unknown) {
      if (stopping) return
      let id: string | undefined
      let operation: "open" | "data" | "close" | undefined
      try {
        if (!value || typeof value !== "object") throw Error("Invalid desktop host command")
        const cmd = value as Record<string, unknown>
        if (cmd.type === "ping") { send({ type: "pong" }); return }
        if (cmd.type === "open" || cmd.type === "data" || cmd.type === "close") operation = cmd.type
        if (typeof cmd.workspaceId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(cmd.workspaceId)
          || (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cmd.workspaceId))) throw Error("Invalid workspace identity")
        id = cmd.workspaceId
        if (cmd.type === "open") {
          if (typeof cmd.workspacePath !== "string" || !isAbsolute(cmd.workspacePath)) throw Error("Absolute workspace path required")
          await open(id, resolve(cmd.workspacePath))
          return
        }
        const scope = scopes.get(fileKey(id))
        if (scope && scope.id !== id) throw Error("Workspace channel identity mismatch")
        if (cmd.type === "close") {
          if (scope?.closeFlight) return
          if (scope) await retire(scope)
          if (!stopping) send({ type: "closed", workspaceId: id })
          return
        }
        if (cmd.type !== "data" || typeof cmd.line !== "string") throw Error("Invalid desktop host command")
        if (!scope) throw Error("Workspace channel is not open")
        await data(scope, cmd.line)
      } catch (error) {
        if (!stopping) send({ type: "error", ...(id === undefined ? {} : { workspaceId: id, operation }), message: messageOf(error) })
      }
    },
    async close() {
      stopping = true
      const results = await Promise.allSettled([...scopes.values()].map(retire))
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, "Desktop host workspace cleanup incomplete")
    },
  }
}
