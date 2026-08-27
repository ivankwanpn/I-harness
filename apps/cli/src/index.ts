import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export { runHeadless } from "./run.ts"
export type { HeadlessOptions, HeadlessResult } from "./run.ts"

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
  if (args[0] !== "run") {
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--session-backend jsonl|sqlite] [--resume ID]")
    return Promise.resolve(1)
  }

  const yes = args.includes("--yes")
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
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--session-backend") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume" && prev !== "--session-backend"
  })
  const task = taskArgs.join(" ")
  if (!task) {
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--session-backend jsonl|sqlite] [--resume ID]")
    return Promise.resolve(1)
  }

  const opts: HeadlessOptions = { workspace: process.cwd(), approveAll: yes }
  if (model) opts.model = model
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
