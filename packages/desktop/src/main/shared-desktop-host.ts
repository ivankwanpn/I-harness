import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough, Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HarnessClient } from "@i-harness/sdk"
import type { DesktopActivityReport, DesktopHostCommand, DesktopHostEvent } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import type { LaunchedRuntime } from "./sdk-runtime.ts"
import type { WorkspaceEntry } from "./workspaces.ts"
import { createHostCommandWriter } from "./host-command-writer.ts"

interface Channel {
  input: PassThrough
  isolatedWorktree: boolean
  opened: ReturnType<typeof Promise.withResolvers<void>>
  ready: boolean
  exited: ReturnType<typeof Promise.withResolvers<void>>
  disconnected: ReturnType<typeof Promise.withResolvers<void>>
  closing?: ReturnType<typeof Promise.withResolvers<void>>
  releasing: boolean
  diagnostic?: string
}

class WorkspaceClient extends HarnessClient {
  constructor(input: PassThrough, output: Writable, private release: () => Promise<void>) { super(input, output) }
  override async close() {
    try { await super.close() } finally { await this.release() }
  }
}

function deadline<T>(work: Promise<T>, ms: number, message: string, expired?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired?.(); reject(new Error(message)) }, ms)
    timer.unref()
  })]).finally(() => clearTimeout(timer))
}

function connect(child: ChildProcessWithoutNullStreams) {
  const channels = new Map<string, Channel>()
  const ended = Promise.withResolvers<void>()
  let stopping = false
  let supportsActivity = false
  let stderr = ""
  let exitInfo: { code: number | null; signal: string | null } | undefined
  let pong: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let nextActivityRequest = 0
  const activityRequests = new Map<number, ReturnType<typeof Promise.withResolvers<DesktopActivityReport>>>()
  let misses = 0
  child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-8192) })
  function endChannel(id: string, channel: Channel, error?: Error) {
    channels.delete(id)
    channel.opened.reject(error ?? new Error("Workspace closed before startup finished"))
    // EOF rejects pending SDK calls. The process diagnostic is reported by
    // the manager; emitting an error here would also error readline itself.
    if (!channel.input.writableEnded) channel.input.end()
    channel.disconnected.resolve()
    channel.closing?.resolve()
    channel.exited.resolve()
  }
  function terminate(error: Error) {
    if (!stopping) stderr = (stderr + "\n" + error.message).slice(-8192)
    stopping = true
    child.kill("SIGKILL")
  }
  child.on("error", error => { stderr = (stderr + "\n" + error.message).slice(-8192) })
  child.once("close", (code, signal) => {
    clearInterval(health)
    if ((code !== 0 || signal) && stderr) console.warn("[desktop-host] process exited:", stderr)
    stopping = true
    exitInfo = { code, signal }
    const error = new Error("Desktop host exited (" + (signal ?? code) + ")")
    pong?.reject(error)
    for (const pending of activityRequests.values()) pending.reject(error)
    for (const [id, channel] of channels) endChannel(id, channel, error)
    ended.resolve()
  })
  child.stdin.on("error", terminate)
  child.stdout.on("error", terminate)
  child.stdout.once("end", () => { if (!stopping) terminate(new Error("Desktop host output ended unexpectedly")) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on("error", terminate)
  lines.on("line", text => {
    try {
      const event: DesktopHostEvent = JSON.parse(text)
      if (event.type === "pong") { pong?.resolve(); return }
      if (event.type === "activity") { activityRequests.get(event.requestId)?.resolve(event); return }
      if (!event.workspaceId) throw new Error(event.type === "error" ? event.message : "Unscoped host response")
      const channel = channels.get(event.workspaceId)
      if (!channel) throw new Error("Desktop host replied on an unknown workspace")
      switch (event.type) {
        case "opened":
          if (channel.isolatedWorktree && event.isolatedWorktree !== true) {
            channel.opened.reject(new Error("The Gateway did not confirm worktree isolation"))
            void releaseChannel(event.workspaceId, channel).catch(() => {})
            break
          }
          supportsActivity = event.activityReports === 1
          channel.ready = true
          channel.opened.resolve()
          break
        case "data":
          if (typeof event.line !== "string") throw new Error("Invalid workspace data")
          if (!channel.releasing && !channel.input.writableEnded) channel.input.write(event.line + "\n")
          break
        case "closed": endChannel(event.workspaceId, channel); break
        case "error": {
          const error = new Error(event.message)
          channel.diagnostic = error.message.slice(-8192)
          if (event.operation === "open" && !channel.ready) {
            channel.opened.reject(error)
            if (!channel.closing) endChannel(event.workspaceId, channel, error)
          } else if (event.operation === "close" && channel.releasing) {
            const attempt = channel.closing
            channel.closing = undefined
            attempt?.reject(error)
          } else {
            // A failed data channel has lost its request/reply contract.
            // Keep ownership until the server confirms workspace teardown.
            disconnectChannel(event.workspaceId, channel)
          }
          break
        }
        default: throw new Error("Invalid desktop host response")
      }
    } catch (error) { terminate(error instanceof Error ? error : new Error(String(error))) }
  })
  const commands = createHostCommandWriter(child.stdin, (id, line) => channels.get(id)?.input.write(line))
  function send(frame: DesktopHostCommand) {
    if (stopping) throw new Error("Desktop host is stopping")
    commands.send(frame)
  }
  // Probe the physical process once, regardless of the number of open projects.
  const health = setInterval(async () => {
    if (stopping || pong || channels.size === 0) return
    pong = Promise.withResolvers<void>()
    try {
      send({ type: "ping" })
      await deadline(pong.promise, 10_000, "Desktop host heartbeat timed out")
      misses = 0
    } catch {
      if (!stopping && ++misses >= 2) terminate(new Error("Desktop host missed two heartbeats"))
    } finally { pong = undefined }
  }, 20_000)
  health.unref()
  function disconnectChannel(id: string, channel: Channel) {
    if (!channel.input.writableEnded) channel.input.end()
    channel.disconnected.resolve()
    void releaseChannel(id, channel).catch(() => { /* The manager retains the original owner for retry. */ })
  }
  async function releaseChannel(id: string, channel: Channel) {
    if (channels.get(id) !== channel) return
    channel.releasing = true
    if (!channel.closing) {
      const receipt = channel.closing = Promise.withResolvers<void>()
      try { send({ type: "close", workspaceId: id }) }
      catch (error) { channel.closing = undefined; throw error }
      // Keep the receipt until an acknowledgement or a definite server error.
      // Retrying after a local timeout must not issue a second close for an ID
      // which may already have been released by the first request.
      void receipt.promise.catch(() => undefined)
    }
    await deadline(channel.closing.promise, 30_000, "Workspace cleanup timed out", () => {
      if ([...channels.values()].every(scope => scope.releasing)) terminate(new Error("Desktop host cleanup timed out"))
    })
  }
  return {
    exited: ended.promise,
    get stopping() { return stopping },
    get pid() { return child.pid },
    get empty() { return channels.size === 0 },
    get supportsActivity() { return supportsActivity },
    async inspectActivity(ids?: string[]) {
      if (!supportsActivity) throw new Error("Host does not support activity reports")
      // Capture channel objects before writing. A reply about an old channel
      // cannot release its replacement, even when both use the same ID.
      const expected = new Map((ids ?? [...channels.keys()]).map(id => [id, channels.get(id)]))
      const requestId = ++nextActivityRequest
      const pending = Promise.withResolvers<DesktopActivityReport>()
      activityRequests.set(requestId, pending)
      try {
        send({ type: "activity", requestId, workspaceIds: ids })
        const report = await deadline(pending.promise, 2500, "Host activity inspection timed out")
        if (typeof report.profileActive !== "boolean" || !Array.isArray(report.scopes) || report.scopes.length !== expected.size) throw Error("Incomplete host activity report")
        const seen = new Set<string>(), idle = new Set<string>()
        for (const row of report.scopes) {
          if (!Array.isArray(row) || row.length !== 2 || !expected.has(row[0]) || typeof row[1] !== "boolean" || seen.has(row[0])) throw Error("Invalid host activity report")
          const [id, active] = row
          seen.add(id)
          const original = expected.get(id)
          if (!active && original?.ready && !original.releasing && channels.get(id) === original) idle.add(id)
        }
        return { idle, scopeCount: seen.size, profileActive: report.profileActive }
      } finally { activityRequests.delete(requestId) }
    },
    open(workspace: WorkspaceEntry): LaunchedRuntime {
      const id = workspace.id
      if (channels.has(id)) throw new Error("Previous workspace scope has not closed")
      const channel: Channel = {
        input: new PassThrough(), opened: Promise.withResolvers<void>(), exited: Promise.withResolvers<void>(),
        disconnected: Promise.withResolvers<void>(), releasing: false, ready: false, isolatedWorktree: !!workspace.worktree,
      }
      channels.set(id, channel)
      const sendData = (text: string) => {
        if (channels.get(id) !== channel || channel.releasing) throw new Error("Workspace channel is retired")
        send({ type: "data", workspaceId: id, line: text.endsWith("\n") ? text.slice(0, -1) : text })
      }
      const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
        if (channel.ready) {
          try { sendData(chunk.toString("utf8")); callback() } catch (error) { callback(error as Error) }
        } else {
          void channel.opened.promise.then(() => sendData(chunk.toString("utf8"))).then(() => callback(), callback)
        }
      } })
      output.on("error", () => {
        if (!channel.releasing && channels.get(id) === channel) disconnectChannel(id, channel)
      })
      const client = new WorkspaceClient(channel.input, output, () => releaseChannel(id, channel))
      const ready = deadline(channel.opened.promise, 60_000, "Workspace startup timed out")
      // A simultaneous application quit may retire this launch before the
      // manager reaches its startup await.
      void ready.catch(() => undefined)
      try { send({ type: "open", workspaceId: id, workspacePath: workspace.path, activityReports: 1, ...(workspace.worktree ? { isolatedWorktree: true } : {}) }) }
      catch (error) { endChannel(id, channel, error as Error) }
      return { client, ready, hostPid: child.pid, disconnected: channel.disconnected.promise,
        exited: channel.exited.promise, stderrTail: () => channel.diagnostic ?? "", exitInfo: () => exitInfo }
    },
    async shutdown() {
      if (!stopping) {
        try {
          send({ type: "shutdown" })
          stopping = true
          commands.end()
        } catch (error) { terminate(error as Error) }
      }
      try { await deadline(ended.promise, 5000, "Desktop host shutdown timed out") }
      catch (error) {
        terminate(error as Error)
        await deadline(ended.promise, 2500, "Desktop host did not exit")
      }
      if (exitInfo?.code !== 0) throw new Error("Desktop host exited without confirming cleanup (" + (exitInfo?.signal ?? exitInfo?.code) + ")")
    },
  }
}

/** Electron owns one lazy child; each workspace gets its own SDK connection. */
export function createSharedDesktopHost(sessionsRoot: string, resourcesPath?: string) {
  let host: ReturnType<typeof connect> | undefined
  function start() {
    const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)))
    const args = resourcesPath
      ? [realpathSync.native(join(resourcesPath, "gateway", "cli", "src", "cli.js"))]
      : ["--import", pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href, join(repo, "packages/desktop-gateway/src/cli.ts")]
    const child = spawn(process.execPath, [...args, "--desktop-host", "--sessions-root", sessionsRoot], {
      cwd: sessionsRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1",
        ...(process.env.IH_CONFIG_DIR ? { IH_CONFIG_DIR: resolve(process.env.IH_CONFIG_DIR) } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    const connection = connect(child)
    void connection.exited.then(() => { if (host === connection) host = undefined })
    return connection
  }
  return {
    get supportsActivity() { return host?.supportsActivity ?? true },
    status() {
      const process = !host ? "standby" : host.stopping ? "stopping" : "running"
      return { process, pid: host?.pid } as const
    },
    async inspectActivity(ids?: string[]) {
      if (!host) return { idle: new Set<string>(), scopeCount: 0, profileActive: false }
      return host.inspectActivity(ids)
    },
    async launch(workspace: WorkspaceEntry) {
      if (host?.stopping) await deadline(host.exited, 7500, "Previous desktop host has not exited")
      return (host ??= start()).open(workspace)
    },
    async retireIfEmpty() {
      const current = host
      if (!current?.empty || current.stopping) return
      if (!current.supportsActivity) { await current.shutdown(); return }
      // A device login can outlive the workspace that initiated it.
      const profile = await current.inspectActivity([]).catch(() => undefined)
      if (host === current && current.empty && profile?.profileActive === false) await current.shutdown()
    },
    async close() { if (host) await host.shutdown() },
  }
}
