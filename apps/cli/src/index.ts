import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createFileBackedSessionQuery, type SessionQuery } from "@i-harness/session-query"
import { createSessionService } from "@i-harness/session-executor"
import type { SessionAssembly } from "@i-harness/session-executor"
import { RewindService } from "@i-harness/rewind"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, type SessionListEntry } from "@i-harness/sdk"
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

// M31: no hardcoded model catalogs — gemini/bedrock built-in profiles keep
// only the config template (protocol/defaultModel); `models: []` + no
// `modelContexts`. The model list comes from the user settings (adopt via the
// web-host probe-apply, spec §2.3 — nothing is preset by the CLI).
export function parseModel(modelSpec: string, apiKey: string): ModelClient {
  const [provider, model] = modelSpec.split(":")
  const reg = createProviderRegistry()
  // built-in convenience profiles so the CLI keeps working without user config
  reg.register({ name: "openai", displayName: "OpenAI", protocol: "openai-responses", apiKey, models: [], defaultModel: "gpt-4o" })
  reg.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey, models: [], defaultModel: "deepseek-chat" })
  reg.register({ name: "anthropic", displayName: "Anthropic", protocol: "anthropic-messages", apiKey, models: [], defaultModel: "claude-3-5-sonnet-latest" })
  reg.register({ name: "gemini", displayName: "Google Gemini", protocol: "gemini", apiKey, models: [], defaultModel: "gemini-2.5-pro" })
  reg.register({ name: "bedrock", displayName: "Amazon Bedrock", protocol: "bedrock", models: [], defaultModel: "anthropic.claude-3-5-sonnet-20241022" })
  const profile = reg.get(provider ?? "")
  if (!profile) throw new Error(`unknown model provider: ${provider}`)
  return buildModelClient(profile, model)
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  // M29: --session-backend is removed — JSONL is the only persistence backend
  // and the search index is derived from it (reconcile-on-search). Fail loud
  // instead of silently ignoring the old flag.
  if (args.includes("--session-backend")) {
    console.error("--session-backend is removed (M29: JSONL-only persistence; the search index derives from the store)")
    return Promise.resolve(1)
  }
  // R-C1 web subcommand: the thin composition over the session service
  // (apps/cli/src/web.ts). PORT env wins over the default; the workspace is
  // the cwd; auth is opt-in (--launch-token/--hmac-secret) — absent = no
  // fence (dev), present = the R-C3 fence.
  if (args[0] === "web") {
    const launchIdx = args.indexOf("--launch-token")
    const hmacIdx = args.indexOf("--hmac-secret")
    const launchToken = launchIdx !== -1 ? args[launchIdx + 1] : process.env.I_HARNESS_TOKEN
    const hmacSecret = hmacIdx !== -1 ? args[hmacIdx + 1] : process.env.I_HARNESS_HMAC
    const opts: WebServerOptions = {
      // H-4: flag > PORT env > default (4310) — pickWebPort owns the priority.
      port: pickWebPort(args, process.env.PORT),
      workspace: process.cwd(),
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
  // stderr. `i-harness sdk [--session-dir DIR]`
  if (args[0] === "sdk") {
    return runSdkCommand(args)
  }
  // R-C7 acp subcommand: official-ACP (v1) stdio server over the SessionService.
  // Same stdout discipline as `sdk` — ONLY ACP NDJSON frames on stdout.
  if (args[0] === "acp") {
    return runAcpCommand(args)
  }
  if (args[0] !== "run") {
    console.error("usage: i-harness <run|web|sdk|acp> ... — run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--resume ID] [--telemetry] | web [--port N] [--launch-token TOKEN] [--hmac-secret SECRET] | sdk [--session-dir DIR] | acp [--session-dir DIR] [--no-auto-approve]")
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

  // persistence wiring (M29: JSONL-only — locked under the store root).
  let coordinator: SessionCoordinator | undefined
  let sessionId: string | undefined
  let resumeSessionId: string | undefined
  if (sessionDirIdx !== -1) {
    const dir = args[sessionDirIdx + 1]
    if (!dir) {
      console.error("--session-dir requires a directory")
      return Promise.resolve(1)
    }
    // M23: the CLI opts into the session ownership lease with lockRoot = the
    // session STORE directory — lock files share the store's lifecycle, and a
    // conflicting live writer fails the create below (fail-closed) instead of
    // silently double-writing.
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
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
  // M30: bedrock is key-less by design (AWS credential chain) — the key
  // requirement is exempted for the bedrock route only.
  let model: ModelClient | undefined
  if (modelIdx !== -1) {
    const modelSpec = args[modelIdx + 1]
    const apiKey = args[keyIdx + 1]
    const needsApiKey = modelSpec?.split(":")[0] !== "bedrock"
    if (!modelSpec || (needsApiKey && (keyIdx === -1 || !apiKey))) {
      console.error("--model requires --api-key KEY")
      return Promise.resolve(1)
    }
    try {
      model = parseModel(modelSpec, apiKey ?? "")
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return Promise.resolve(1)
    }
  }

  // task = everything after the "run" command, excluding flag tokens/values.
  const taskArgs = args.slice(1).filter((a, i) => {
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--telemetry") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume"
  })
  const task = taskArgs.join(" ")
  if (!task) {
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--resume ID] [--telemetry]")
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
  const dirIdx = args.indexOf("--session-dir")
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      console.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(createJsonlBackend(dir))
  }
  const service = createSessionService({
    workspace: process.cwd(),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    // M41b v1.1: rewind engine — the assembly creates the RewindStore +
    // RewindRecorder per session (keyed on sessionId) and records turns; the
    // rewindFactory below serves the rewind surface over that handle. Only
    // meaningful with a --session-dir (a store root to hang rewind/ under).
    ...(storeRoot !== undefined ? { rewindStoreRoot: storeRoot } : {}),
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

  // M41b v1.1: the server-side rewind seam — mirror of the embedded bridge's
  // svcFor pattern: watch assemblies (the onAssembly hook fires once per live
  // assembly), then resolve the CURRENT assembly's rewind handle per request.
  // The RewindService is rebuilt per call over that handle (never cached — a
  // session switch must not serve a stale store), and the factory returns
  // undefined (→ -32603 "rewind not enabled" on the wire) for an assembly
  // built without rewind or a session this process never opened.
  const liveAssemblies = new Map<string, SessionAssembly>()
  service.onAssembly((assembly) => {
    if (assembly.sessionId !== undefined) liveAssemblies.set(assembly.sessionId, assembly)
  })
  const workspaceRoot = process.cwd()
  const rewindFor = (sessionId: string) => {
    const assembly = liveAssemblies.get(sessionId)
    if (assembly === undefined || assembly.rewind === undefined) return undefined
    const svc = new RewindService({ store: assembly.rewind.store, workspace: workspaceRoot })
    return {
      points: async () => ({
        points: (await svc.points()).map((p) => ({ turnIndex: p.turnIndex, preview: p.preview, files: p.files })),
      }),
      plan: async (target: number, mode: "all" | "files" | "conversation") => {
        const plan = await svc.plan(target, mode)
        // wire FileOp mirrors the engine FileOp minus the blob id (strip)
        return {
          clean: plan.clean.map((f) => ({ path: f.path, op: f.kind })),
          conflicts: plan.conflicts,
          unTracked: plan.unTracked,
          ops: plan.ops.map((f) => ({ path: f.path, op: f.kind })),
        }
      },
      execute: async (target: number, mode: "all" | "files" | "conversation", hooks: { appendEvent: (ev: unknown) => void }) => {
        const result = await svc.execute(target, mode, { appendEvent: (ev) => hooks.appendEvent(ev) })
        return {
          revertedFiles: result.revertedFiles,
          conflicts: result.conflicts,
          ...(result.errors.length > 0
            ? { error: result.errors.map((e) => `${e.path}: ${e.message}`).join("; ") }
            : {}),
        }
      },
    }
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  const server = createSdkServer(service, {
    coordinator,
    // M41b v1.1: the rewind seam (wire-level "session-rewind" capability).
    // Present only with --session-dir (the assembly-side rewindStoreRoot chain
    // above); without it, every rewind method answers "rewind not enabled".
    ...(storeRoot !== undefined ? { rewindFactory: rewindFor } : {}),
    // M41a v1: session/list source — the store listing, web-host mirror
    // (coordinator.list() + header-only profile per row, settled per row so a
    // single corrupt/missing file never fails the whole list; the row is still
    // SERVED with just the id and the failure is loud on stderr). M41b v1.1:
    // rows are enriched — updatedAt (artifact mtime, createdAt fallback) +
    // turnCount (turn/start count from a full-log read — both per-row settled).
    listSessions:
      coordinator === undefined
        ? undefined
        : async () => {
            const ids = await coordinator.list()
            const profiles = await Promise.allSettled(ids.map((id) => coordinator.profile(id)))
            const sessions: SessionListEntry[] = []
            for (let index = 0; index < ids.length; index++) {
              const id = ids[index]!
              const profile = profiles[index]!
              if (profile.status === "rejected") {
                console.error(`[i-harness sdk] session list: profile for "${id}" failed: ${String(profile.reason)}`)
                sessions.push({ id })
                continue
              }
              const meta = profile.value.meta
              const row: SessionListEntry = { id, ...(meta.title !== undefined ? { title: meta.title } : {}) }
              // updatedAt — the artifact mtime (SessionEvents carry no
              // timestamp; SessionMeta has only createdAt — M37b store-listing
              // convention), createdAt ISO as the fallback. (`storeRoot` is
              // defined whenever this source is wired — see the dirIdx guard
              // above; the closure's coordinator presence implies it.)
              const updatedAt = await stat(join(storeRoot!, `${id}.jsonl`))
                .then((s) => s.mtimeMs)
                .catch(() => undefined)
              if (updatedAt !== undefined) {
                row.updatedAt = updatedAt
              } else {
                const parsed = Date.parse(meta.createdAt)
                if (!Number.isNaN(parsed)) row.updatedAt = parsed
              }
              // turnCount — full-log read (turn/start events); a failing load
              // keeps the row honest without the count (loud on stderr).
              try {
                const { session } = await coordinator.load(id)
                row.turnCount = session.events.filter((ev) => ev.type === "turn/start").length
              } catch (error) {
                console.error(
                  `[i-harness sdk] session list: load for "${id}" failed: ${error instanceof Error ? error.message : String(error)}`,
                )
              }
              sessions.push(row)
            }
            return { sessions }
          },
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
  const dirIdx = args.indexOf("--session-dir")
  let coordinator: SessionCoordinator | undefined
  let storeRoot: string | undefined
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1]
    if (dir === undefined || dir === "") {
      console.error("--session-dir requires a directory")
      return 1
    }
    storeRoot = dir
    coordinator = createSessionCoordinator(createJsonlBackend(dir))
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
