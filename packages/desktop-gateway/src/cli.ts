#!/usr/bin/env node
import { createInterface } from "node:readline"
import { basename, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_WRITE_BOUND_BYTES, decodeFrame, isRpcRequest } from "@i-harness/sdk"
import type { DesktopHost } from "./host.ts"
import { createDesktopHostOutput, createGatewayOutput, type GatewayOutputSink } from "./output.ts"
import { createWorkspaceHosts } from "./workspace-hosts.ts"
import { createConfigurationHost, createDesktopProfileServices } from "./configuration-host.ts"
import { DESKTOP_CONFIGURATION_ID } from "./host-protocol.ts"
import { closeSystemFetch } from "@i-harness/http-transport"

function stdoutSink(): GatewayOutputSink {
  return {
    write: (chunk) => process.stdout.write(chunk),
    end: () => process.stdout.end(),
    onDrain: (callback) => {
      process.stdout.once("drain", callback)
      return () => { process.stdout.off("drain", callback) }
    },
  }
}

async function runDesktopHost(sessionsRoot: string): Promise<number> {
  const profile = createDesktopProfileServices()
  const done = Promise.withResolvers<void>()
  const lines = createInterface({ input: process.stdin, terminal: false })
  let stopping = false
  let status = 0
  function stop() {
    if (stopping) return
    stopping = true
    lines.close()
    // The parent can keep its write end open while it awaits the process exit.
    // readline.close() alone leaves the Windows stdin pipe referenced.
    process.stdin.destroy()
    done.resolve()
  }
  const output = createDesktopHostOutput(stdoutSink(), DEFAULT_WRITE_BOUND_BYTES, () => { status = 1; stop() })
  const hosts = createWorkspaceHosts(sessionsRoot, async options => basename(options.sessionDir) === DESKTOP_CONFIGURATION_ID
    ? createConfigurationHost(profile, options.onWrite)
    : (await import("./host.ts")).createDesktopHost({ ...options, profile }), event => output.push(event), () => profile.accounts.hasActiveLogin())
  function outputFailed() {
    status = 1
    try { output.abort() } catch { /* The parent pipe is already broken. */ }
    stop()
  }
  lines.on("line", line => {
    if (stopping) return
    let command: unknown
    try { command = JSON.parse(line) } catch { command = undefined }
    if ((command as { type?: unknown } | null)?.type === "shutdown") { stop(); return }
    void hosts.receive(command).catch(outputFailed)
  })
  lines.once("close", stop)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stdout.once("error", outputFailed)
  try {
    await done.promise
    try { await hosts.close() } finally { await profile.close() }
  } finally {
    try { await closeSystemFetch() } finally {
      await output.finish()
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      process.stdout.off("error", outputFailed)
    }
  }
  return status
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 3 && args[0] === "--desktop-host" && args[1] === "--sessions-root" && isAbsolute(args[2]!)) {
    return runDesktopHost(args[2]!)
  }
  if (args.length !== 2 || args[0] !== "--session-dir" || !isAbsolute(args[1]!)) {
    console.error("usage: desktop-gateway --desktop-host --sessions-root ABSOLUTE_DIR | --session-dir ABSOLUTE_DIR")
    return 1
  }

  let requestClose = () => {}
  const output = createGatewayOutput(stdoutSink(), DEFAULT_WRITE_BOUND_BYTES, () => requestClose())

  let host: DesktopHost
  try {
    const { createDesktopHost } = await import("./host.ts")
    host = await createDesktopHost({
      workspace: process.cwd(),
      sessionDir: args[1],
      onWrite: (frame) => output.push(frame),
    })
  } catch (error) {
    console.error(`[desktop-gateway] startup failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  const active = new Set<Promise<void>>()
  let handshake: Promise<void> | undefined
  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = Promise.resolve().then(async () => {
      rl.close()
      try { await host.close() }
      finally { await closeSystemFetch() }
      await Promise.allSettled([...active])
      await output.finish()
    })
    return closing
  }
  requestClose = () => { void close() }

  function track(work: Promise<void>): void {
    active.add(work)
    void work.catch((error) => {
      console.error(`[desktop-gateway] request failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { active.delete(work) })
  }

  rl.on("line", (line) => {
    const frame = decodeFrame(line)
    const method = isRpcRequest(frame) ? frame.method : undefined
    // NG-09: the protocol's shutdown is a request, but older clients (and the
    // SDK before this fix) send a bare notification. Either form must start
    // teardown instead of waiting for the 2s kill.
    const shutdown = method === "shutdown" || (typeof frame === "object" && frame !== null && "method" in frame && frame.method === "shutdown")
    if (method === "initialize") {
      handshake = host.handleLine(line)
      track(handshake)
      return
    }
    const work = (handshake ?? Promise.resolve()).then(() => host.handleLine(line))
    track(work)
    if (shutdown) void work.then(() => close(), () => close())
  })
  rl.on("close", () => { void close() })
  const onSignal = () => { void close() }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  process.stdout.once("error", onSignal)

  await new Promise<void>((resolve) => rl.once("close", resolve))
  await close()
  await Promise.allSettled([...active])
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  process.stdout.off("error", onSignal)
  return 0
}

// The gateway is a long-lived child of the desktop app. A rejected
// fire-and-forget task (for example an optional title request) must be
// reported, not allowed to terminate the whole session process.
function reportFatal(reason: unknown, shared: boolean): void {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  console.error(`[desktop-gateway] fatal: ${message}`)
  try {
    // A structured fatal notification lets the desktop show the real failure
    // before/with the process exit instead of only "subprocess exited".
    const frame = shared ? { type: "error", message: message.slice(0, 8192) }
      : { jsonrpc: "2.0", method: "desktop/gateway/fatal", params: { message: reason instanceof Error ? reason.message : String(reason), diagnostic: message.slice(0, 8192) } }
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  } catch { /* stderr remains the fallback diagnostic */ }
}

export function runGatewayCli(args: string[]): void {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    console.error(`[desktop-gateway] unhandled rejection: ${message}`)
  })
  const fatal = (error: unknown) => {
    const shared = args[0] === "--desktop-host"
    reportFatal(error, shared)
    if (shared) process.exit(1)
    process.exitCode = 1
  }
  process.on("uncaughtException", fatal)
  void main(args).then(code => { process.exitCode = code }, fatal)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) runGatewayCli(process.argv.slice(2))
