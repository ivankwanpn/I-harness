import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createFileBackedSessionQuery, type SessionQuery } from "@i-harness/session-query"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame } from "@i-harness/sdk"
import { createAcpServer } from "@i-harness/acp"
import { parsePort, runWebServer } from "./web.ts"
import type { WebServerOptions } from "./web.ts"

export { runHeadless } from "./run.ts"
export type { HeadlessOptions, HeadlessResult } from "./run.ts"

/**
 * H-4: web port selection — `--port N` flag beats the PORT env var, which
 * beats the 4310 default. Flag values must be positive integers; anything
 * else falls through to the env (or the default). The env path reuses
 * `parsePort` (web.ts) so PORT=0 (OS-assigned) stays valid there.
 */
export function pickWebPort(args: string[], envPort: string | undefined): number {
  const idx = args.indexOf("--port")
  const flagPort = idx !== -1 ? Number(args[idx + 1]) : undefined
  return flagPort !== undefined && Number.isInteger(flagPort) && flagPort > 0
    ? flagPort
    : envPort !== undefined ? parsePort(envPort) : 4310
}

export function parseModel(modelSpec: string, apiKey: string): ModelClient {
  const [provider, model] = modelSpec.split(":")
  const reg = createProviderRegistry()
  // built-in convenience profiles so the CLI keeps working without user config
  reg.register({ name: "openai", displayName: "OpenAI", protocol: "openai-responses", apiKey, models: [], defaultModel: "gpt-4o" })
  reg.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey, models: [], defaultModel: "deepseek-chat" })
  reg.register({ name: "anthropic", displayName: "Anthropic", protocol: "anthropic-messages", apiKey, models: [], defaultModel: "claude-3-5-sonnet-latest" })
  const profile = reg.get(provider ?? "")
  if (!profile) throw new Error(`unknown model provider: ${provider}`)
  return buildModelClient(profile, model)
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  // R-C1 web subcommand: the thin composition over the session service
  // (apps/cli/src/web.ts). PORT env wins over the default; the workspace is
  // the cwd; auth is opt-in (--launch-token/--hmac-secret) — absent = no
  // fence (dev), present = the R-C3 fence.
  if (args[0] === "web") {
    const backendIdx = args.indexOf("--session-backend")
    const sessionBackend = backendIdx !== -1 && args[backendIdx + 1] === "sqlite" ? "sqlite" : "jsonl"
    const launchIdx = args.indexOf("--launch-token")
    const hmacIdx = args.indexOf("--hmac-secret")
    const launchToken = launchIdx !== -1 ? args[launchIdx + 1] : process.env.I_HARNESS_TOKEN
    const hmacSecret = hmacIdx !== -1 ? args[hmacIdx + 1] : process.env.I_HARNESS_HMAC
    const opts: WebServerOptions = {
      // H-4: flag > PORT env > default (4310) — pickWebPort owns the priority.
      port: pickWebPort(args, process.env.PORT),
      workspace: process.cwd(),
      sessionBackend,
      ...(launchToken !== undefined || hmacSecret !== undefined
        ? { auth: { launchToken, hmacSecret }, printLoginUrl: true }
        : {}),
    }
    try {
      const result = await runWebServer(opts)
      return Promise.resolve(result.port)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return Promise.resolve(1)
    }
  }
  // R-C4 sdk subcommand: NDJSON JSON-RPC 2.0 stdio server (hosted by the
  // SessionService). stdout carries ONLY protocol frames — every log goes to
  // stderr. `i-harness sdk [--session-dir DIR] [--session-backend jsonl|sqlite]`
  if (args[0] === "sdk") {
    return runSdkCommand(args)
  }
  // R-C7 acp subcommand: official-ACP (v1) stdio server over the SessionService.
  // Same stdout discipline as `sdk` — ONLY ACP NDJSON frames on stdout.
  if (args[0] === "acp") {
    return runAcpCommand(args)
  }
  if (args[0] !== "run") {
    console.error("usage: i-harness <run|web|sdk|acp> ... — run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--session-backend jsonl|sqlite] [--resume ID] [--telemetry] | web [--port N] [--session-backend jsonl|sqlite] [--launch-token TOKEN] [--hmac-secret SECRET] | sdk [--session-dir DIR] [--session-backend jsonl|sqlite] | acp [--session-dir DIR] [--session-backend jsonl|sqlite] [--no-auto-approve]")
    return Promise.resolve(1)
  }

  const yes = args.includes("--yes")
  // M25: --telemetry enables the independent host event stream (stdout JSONL
  // sink, assembled in run.ts). Default OFF; I_HARNESS_TELEMETRY=1 is the
  // env-var equivalent.
  const telemetry = args.includes("--telemetry") || process.env.I_HARNESS_TELEMETRY === "1"
  const modelIdx = args.indexOf("--model")
  const keyIdx = args.indexOf("--api-key")
  const sessionDirIdx = args.indexOf("--session-dir")
  const resumeIdx = args.indexOf("--resume")
  const backendIdx = args.indexOf("--session-backend")
  let sessionBackend: "jsonl" | "sqlite" = "jsonl"
  if (backendIdx !== -1) {
    const value = args[backendIdx + 1]
    if (value === "sqlite" || value === "jsonl") sessionBackend = value
    else {
      console.error("--session-backend must be jsonl or sqlite")
      return Promise.resolve(1)
    }
  }

  // persistence wiring
  let coordinator: SessionCoordinator | undefined
  let sessionId: string | undefined
  let resumeSessionId: string | undefined
  if (sessionDirIdx !== -1) {
    const dir = args[sessionDirIdx + 1]
    if (!dir) {
      console.error("--session-dir requires a directory")
      return Promise.resolve(1)
    }
    if (sessionBackend === "sqlite") {
      // M23: the CLI opts into the session ownership lease with lockRoot = the
      // session STORE directory (jsonl store root / sqlite db dir) — lock files
      // share the store's lifecycle, and a conflicting live writer fails the
      // create below (fail-closed) instead of silently double-writing.
      coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")), { lock: { enabled: true, lockRoot: dir } })
    } else {
      coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
    }
    if (resumeIdx !== -1) {
      resumeSessionId = args[resumeIdx + 1]
      if (!resumeSessionId) {
        console.error("--resume requires a session id")
        return Promise.resolve(1)
      }
    } else {
      try {
        const { id } = await coordinator.create()
        sessionId = id
      } catch (err) {
        // M23: with the lock enabled, create() fails closed —
        // SessionLockConflictError (another live writer owns the lease, message
        // carries the lock path + deadline diagnostics) or
        // SessionLockUnsupportedError off-Windows (M24 boundary). Surface the
        // message cleanly (exitCode 1) instead of an unhandled rejection.
        console.error(err instanceof Error ? err.message : String(err))
        return Promise.resolve(1)
      }
    }
  }

  // M29: the search/lineage surface mounts out of the box once the STORE ROOT
  // is known — a file-backed query derives from the jsonl store
  // (reconcile-on-search; default :memory: index, process-private).
  let sessionQuery: SessionQuery | undefined
  if (sessionDirIdx !== -1 && args[sessionDirIdx + 1] !== undefined) {
    sessionQuery = createFileBackedSessionQuery({ storeRoot: args[sessionDirIdx + 1]! })
  }

  // --model requires --api-key: fail loud rather than silently falling back.
  let model: ModelClient | undefined
  if (modelIdx !== -1) {
    const modelSpec = args[modelIdx + 1]
    const apiKey = args[keyIdx + 1]
    if (keyIdx === -1 || !modelSpec || !apiKey) {
      console.error("--model requires --api-key KEY")
      return Promise.resolve(1)
    }
    try {
      model = parseModel(modelSpec, apiKey)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return Promise.resolve(1)
    }
  }

  // task = everything after the "run" command, excluding flag tokens/values.
  const taskArgs = args.slice(1).filter((a, i) => {
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--session-backend" || a === "--telemetry") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume" && prev !== "--session-backend"
  })
  const task = taskArgs.join(" ")
  if (!task) {
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--session-backend jsonl|sqlite] [--resume ID] [--telemetry]")
    return Promise.resolve(1)
  }

  const opts: HeadlessOptions = { workspace: process.cwd(), approveAll: yes }
  if (model) opts.model = model
  if (telemetry) opts.telemetry = "jsonl"
  if (coordinator) {
    opts.coordinator = coordinator
    if (sessionId) opts.sessionId = sessionId
    if (resumeSessionId) opts.resumeSessionId = resumeSessionId
  }
  if (sessionQuery) opts.sessionQuery = sessionQuery
  return runHeadless(task, opts).then((r) => {
    if (r.finalText) console.log(r.finalText)
    if (r.error) console.error(r.error)
    return r.exitCode
  })
}

/** `i-harness sdk` — the SDK stdio server (R-C4). One NDJSON JSON-RPC line
 * per frame; every response/notification is written through onWrite so stdout
 * NEVER carries host logs (all diagnostics go to stderr). Exits cleanly when
 * the client ends stdin or issues shutdown. */
async function runSdkCommand(args: string[]): Promise<number> {
  const backendIdx = args.indexOf("--session-backend")
  const dirIdx = args.indexOf("--session-dir")
  const sessionBackend: "jsonl" | "sqlite" = backendIdx !== -1 && args[backendIdx + 1] === "sqlite" ? "sqlite" : "jsonl"
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      console.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(
      sessionBackend === "sqlite"
        ? createSqliteBackend(join(dir, "sessions.db"))
        : createJsonlBackend(dir),
    )
  }
  const service = createSessionService({
    workspace: process.cwd(),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => {
            try {
              return (await coordinator.profile(id)).meta
            } catch {
              return undefined // unknown session: the sdk server creates it first
            }
          },
        }
      : {}),
  })

  const rl = createInterface({ input: process.stdin, terminal: false })
  const server = createSdkServer(service, {
    coordinator,
    onWrite: (message) => process.stdout.write(encodeFrame(message)),
    onShutdown: () => rl.close(),
  })

  let tornDown = false
  const teardown = async (): Promise<void> => {
    if (tornDown) return
    tornDown = true
    rl.close()
    await server.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
  }
  rl.on("close", () => { void teardown() })
  const onSignal = (): void => { void teardown() }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  rl.on("line", (line) => {
    void server.handleLine(line).catch((error: unknown) => {
      console.error("[i-harness sdk] loop error:", error instanceof Error ? error.message : String(error))
    })
  })

  // The process lives until the client ends the stdio (or SIGINT), then 0.
  return new Promise<number>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      void teardown().then(() => resolve(0))
    }
    rl.on("close", finish)
  })
}

/** `i-harness acp` — the official-ACP (v1) stdio server (R-C7). The
 * @agentclientprotocol/sdk ndJsonStream is the NDJSON JSON-RPC loop over
 * process stdin/stdout (Web-stream adapted); stdout carries ONLY ACP frames.
 * Version-same flags as `sdk`; `--no-auto-approve` switches the v0 permission
 * face to refuse-prompts (fail-closed) instead of allow-once. */
async function runAcpCommand(args: string[]): Promise<number> {
  const backendIdx = args.indexOf("--session-backend")
  const dirIdx = args.indexOf("--session-dir")
  const sessionBackend: "jsonl" | "sqlite" = backendIdx !== -1 && args[backendIdx + 1] === "sqlite" ? "sqlite" : "jsonl"
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      console.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(
      sessionBackend === "sqlite"
        ? createSqliteBackend(join(dir, "sessions.db"))
        : createJsonlBackend(dir),
    )
  }
  const service = createSessionService({
    workspace: process.cwd(),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => {
            try {
              return (await coordinator.profile(id)).meta
            } catch {
              return undefined // unknown session: session/new is the ACP path to create it
            }
          },
        }
      : {}),
  })
  const server = createAcpServer({
    service,
    ...(coordinator !== undefined ? { coordinator } : {}),
    autoApprove: !args.includes("--no-auto-approve"),
  })

  // The ACP transport: NDJSON in → NDJSON out (official SDK line loop).
  // The SDK's Stream types come from the DOM lib; Node's stream/web types are
  // structurally equivalent at runtime but not assignable there — cast at the
  // adaptor boundary (the stdio round-trip is verified by e2e).
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = server.connect(stream)

  let tornDown = false
  const teardown = async (): Promise<void> => {
    if (tornDown) return
    tornDown = true
    connection.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
  }
  const onSignal = (): void => { void teardown() }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // The process lives until the client ends the stdio (stream EOF closes the
  // connection) or SIGINT/SIGTERM, then 0.
  return new Promise<number>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      void teardown().then(() => resolve(0))
    }
    void connection.closed.then(finish, (error: unknown) => {
      process.stderr.write(
        `[i-harness acp] connection error: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      finish()
    })
  })
}

// Entry guard: invoke main only when this module is executed directly as the
// process entry point (e.g. `node --import tsx apps/cli/src/index.ts run "..."`),
// never when it is merely imported (tests, other modules). Both sides are
// compared as file:// URLs — a raw path string never equals a file URL, so
// comparing import.meta.url (a URL) to pathToFileURL(argv[1]).href holds on
// Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code))
}
