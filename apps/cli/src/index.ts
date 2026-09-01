import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import type { SessionCoordinator } from "@i-harness/session-persistence"
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
  if (args[0] !== "run") {
    console.error("usage: i-harness <run|web> ... — run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--session-backend jsonl|sqlite] [--resume ID] [--telemetry] | web [--port N] [--session-backend jsonl|sqlite] [--launch-token TOKEN] [--hmac-secret SECRET]")
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
  return runHeadless(task, opts).then((r) => {
    if (r.finalText) console.log(r.finalText)
    if (r.error) console.error(r.error)
    return r.exitCode
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
