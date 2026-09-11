import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
// BUG-1 (m49 audit): node:sqlite's ExperimentalWarning is suppressed by the
// session-query package itself (module side effect, evaluated before its
// node:sqlite import) — no explicit wiring needed here.
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createProviderRegistry, buildModelClient } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import { createSessionCoordinator, forkSession } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createFileBackedSessionQuery, type SessionQuery } from "@i-harness/session-query"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import type { SessionAssembly, SessionServiceOptions } from "@i-harness/session-executor"
import type { SandboxMode } from "@i-harness/sandbox"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { createGitProbeForStore, RewindService } from "@i-harness/rewind"
import { createSdkServer } from "@i-harness/sdk/server"
import { encodeFrame, type SessionListEntry } from "@i-harness/sdk"
import { createAcpServer } from "@i-harness/acp"
import { parsePort, runWebServer } from "./web.ts"
import type { WebServerOptions } from "./web.ts"
import { parseFlags, runTui } from "@i-harness/tui-app"
import { CLI_VERSION } from "./web.ts"
import { loadProviderRuntime } from "./provider-runtime.ts"
import { listStoredSessions, runSessionsCommand } from "./sessions.ts"

const USAGE =
  "usage: i-harness [<run|web|sdk|acp|tui|sessions> ...] — BARE (no subcommand) launches the TUI in the current folder (grok-style)\n" +
  "  tui [--prompt <text>] [--workspace <dir>] [--model <spec>] [--yes] [--resume <id>] [--attach <id>] [--minimal|--fullscreen] |\n" +
  "  run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--resume ID] [--telemetry] [--sandbox read-only|workspace-write|danger-full-access] |\n" +
  "  web [--port N] [--session-dir DIR] [--launch-token TOKEN] [--hmac-secret SECRET] | sdk [--session-dir DIR] | acp [--session-dir DIR] [--no-auto-approve] |\n" +
  "  sessions [list] [--session-dir DIR] [--json] | sessions show <id> [--last N]"

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

function providerModelBindingFor(runtime: ProviderRuntime): SessionServiceOptions["modelBindingFor"] {
  return async (_sessionId, meta) => {
    const state = await runtime.resolveModel({
      ...(meta?.modelSelection !== undefined
        ? { sessionSelection: meta.modelSelection }
        : {}),
    })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { model: client, ...binding } }
  }
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
      // M61: the session store the host serves — an explicit --session-dir
      // wins, else the shared default root (the same store the agent keeps).
      ...(args.includes("--session-dir") ? { storeRoot: args[args.indexOf("--session-dir") + 1] } : {}),
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
  // M61: the durable session store's CLI face — list what the TUI persisted
  // and print a transcript of one session (read-only; shares the TUI root).
  if (args[0] === "sessions") {
    return runSessionsCommand(args)
  }
  // R-C7 acp subcommand: official-ACP (v1) stdio server over the SessionService.
  // Same stdout discipline as `sdk` — ONLY ACP NDJSON frames on stdout.
  if (args[0] === "acp") {
    return runAcpCommand(args)
  }
  // M44: the `tui` subcommand + the GROK-STYLE DEFAULT — a bare `i-harness`
  // (or any non-subcommand first token) launches the TUI in the current
  // folder (workspace = cwd), exactly like `grok` in a project folder.
  if (args[0] === "tui") {
    return Promise.resolve(runTui(parseFlags(args.slice(1))))
  }
  // Hidden dist self-check (M55 — scripts/verify-dist.mjs drives it): the
  // surfaces the bundle must serve WITHOUT a source checkout/tsx — the
  // minimal inline engine, the /minimal relaunch argv, the windows-acl
  // confinement, the --attach SDK subprocess. Exit 0 only when every probe
  // passed. Deliberately not in USAGE (a build gate, not a user command).
  if (args[0] === "__dist-selfcheck") {
    return runDistSelfcheck()
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(CLI_VERSION)
    return Promise.resolve(0)
  }
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.error(USAGE)
    return Promise.resolve(0)
  }
  if (args[0] !== "run") {
    // Bare launch == TUI (grok-style); the `run`/`web`/`sdk`/`acp` set stays
    // the headless/backend surface.
    return Promise.resolve(runTui(parseFlags(args)))
  }

  const yes = args.includes("--yes")
  // M62: `--sandbox` is the headless face of `settings.sandboxMode`. Measured
  // gap this closes: HeadlessOptions.sandbox was read from the caller and the
  // CLI could not supply it, so `i-harness run` — the ONLY remaining interface
  // that executes shells — always ran with sandbox unset, i.e. unconfined, no
  // matter what settings.json said. `web` was wired in 891db14 and the TUI has
  // its own path; this is the last one.
  //
  // Resolved HERE rather than inside runHeadless on purpose: HeadlessOptions
  // stays an embedder contract where unset means "no sandbox requested", so the
  // hidden __dist-selfcheck and the exported API keep their meaning.
  const sandboxIdx = args.indexOf("--sandbox")
  let sandboxMode: SandboxMode | undefined
  if (sandboxIdx !== -1) {
    const value = args[sandboxIdx + 1]
    const allowed: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]
    if (value === undefined || !(allowed as readonly string[]).includes(value)) {
      // Never coerce a typo to a default: `--sandbox readonly` silently meaning
      // workspace-write is exactly the false assurance the web fix removed.
      console.error(`--sandbox requires one of: ${allowed.join(" | ")}`)
      return Promise.resolve(1)
    }
    sandboxMode = value as SandboxMode
  } else {
    // Load before reading: an UNLOADED SettingsStore answers get() with DEFAULTS,
    // so skipping this would silently ignore the operator's file (the same trap
    // the web fix hit — see docs/audit/2026-09-10-m62-web-sandbox-not-wired.md).
    const { SettingsStore } = await import("@i-harness/settings")
    const settings = new SettingsStore()
    await settings.load()
    sandboxMode = settings.get().sandboxMode
  }
  // M25: --telemetry enables the independent host event stream (stdout JSONL
  // sink, assembled in run.ts). Default OFF; I_HARNESS_TELEMETRY=1 is the
  // env-var equivalent.
  const telemetry = args.includes("--telemetry") || process.env.I_HARNESS_TELEMETRY === "1"
  const modelIdx = args.indexOf("--model")
  const keyIdx = args.indexOf("--api-key")
  const sessionDirIdx = args.indexOf("--session-dir")
  const resumeIdx = args.indexOf("--resume")

  // `--resume` without a store used to be a SILENT no-op: the id was parsed
  // only inside the `--session-dir` branch below, so the flag was ignored and
  // the run proceeded as a FRESH conversation with exit 0 — the worst shape of
  // failure, because the caller believes the earlier context was restored.
  // Measured: with a store the telemetry's session/start carries the restored
  // `sessionId`; without one the field is absent entirely. A run is ephemeral
  // by design (no store root means no jsonl, no ownership lease), so resuming
  // simply has nothing to resume FROM — say so instead of pretending.
  if (resumeIdx !== -1 && sessionDirIdx === -1) {
    console.error("--resume requires --session-dir DIR (headless runs are ephemeral without a store)")
    return Promise.resolve(1)
  }

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
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume" || a === "--telemetry" || a === "--sandbox") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume" && prev !== "--sandbox"
  })
  const task = taskArgs.join(" ")
  if (!task) {
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--resume ID] [--telemetry] [--sandbox read-only|workspace-write|danger-full-access]")
    return Promise.resolve(1)
  }

  const opts: HeadlessOptions = {
    workspace: process.cwd(),
    approveAll: yes,
    modelPolicy: "required",
    // Mirrors the web path: explicit flag wins, otherwise the operator's setting.
    sandbox: sandboxMode,
  }
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

/** Hidden `__dist-selfcheck` (see the dispatch in main()). Every probe
 * drives the PRODUCTION seam — the inline engine through loadMinimalHost,
 * the SDK subprocess through spawnSdkSubprocess + the host's own argv
 * builder, the windows-acl confinement through createWindowsAclSandbox —
 * never a parallel re-implementation. The relaunch argv is printed for
 * verify-dist to EXECUTE (the probe never claims a spawn it did not make).
 * Exit 0 only when every live probe passed. */
async function runDistSelfcheck(): Promise<number> {
  const tuiApp = await import("@i-harness/tui-app")
  let failed = false
  const record = (label: string, error: unknown): void => {
    failed = true
    console.error(`dist-selfcheck: ${label} FAIL: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    console.log(`minimal-host: ok (${await tuiApp.probeMinimalHost()})`)
  } catch (error) {
    record("minimal-host", error)
  }
  // The REAL /minimal switch argv (relaunchArgs) under the default spawn
  // (defaultRelaunchArgv) — printed for verify-dist to EXECUTE.
  const relaunchArgv = tuiApp.defaultRelaunchArgv(tuiApp.relaunchArgs("minimal", ["tui", "--help"]))
  console.log(`relaunch-argv: ${JSON.stringify(relaunchArgv)}`)
  // The Windows-ACL sandbox seam: confine() must spawn the DIST runner
  // bundle and really confine (child exit mirrored). Windows-only surface.
  if (process.platform === "win32") {
    try {
      console.log(`acl-seam: ok (confined child exit=${await probeAclSeam()})`)
    } catch (error) {
      record("acl-seam", error)
    }
  } else {
    console.log("acl-seam: skipped (non-win32)")
  }
  try {
    const client = tuiApp.spawnSdkSubprocess({
      command: process.execPath,
      args: tuiApp.buildSdkSpawnArgs({ sessionDir: undefined }),
      cwd: process.cwd(),
    })
    try {
      const info = (await client.request("initialize", {}, 30_000)) as { protocolVersion?: unknown }
      if (typeof info.protocolVersion !== "number") {
        throw new Error(`initialize returned no protocolVersion: ${JSON.stringify(info).slice(0, 200)}`)
      }
      console.log(`sdk-spawn: ok (protocolVersion=${info.protocolVersion})`)
    } finally {
      await client.close().catch(() => undefined)
    }
  } catch (error) {
    record("sdk-spawn", error)
  }
  console.log(`dist-selfcheck: ${failed ? "FAIL" : "PASS"}`)
  return failed ? 1 : 0
}

/** Confine a child through the REAL windows-acl seam (createWindowsAclSandbox
 * → confine) and mirror its exit code — proves the BUNDLED seam spawns the
 * sibling `runner.mjs`, not the source tsx entry. Returns the child exit. */
async function probeAclSeam(): Promise<number> {
  const { createWindowsAclSandbox } = await import("@i-harness/sandbox-windows-acl")
  const workspace = mkdtempSync(join(tmpdir(), "ih-dist-acl-"))
  try {
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "read-only" })
    try {
      const confined = provider.confine(
        [process.execPath, "-e", "process.exit(7)"],
        { mode: "read-only", workspaceRoot: workspace },
      )
      if (process.env.I_HARNESS_DIST === "1" && confined.argv.some((arg) => arg.includes("tsx"))) {
        throw new Error(`dist confinement still uses tsx: ${JSON.stringify(confined.argv.slice(0, 5))}`)
      }
      const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { stdio: "inherit", timeout: 120_000 })
      if (result.status !== 7) throw new Error(`confined child exit ${String(result.status)} (expected 7)`)
      return 7
    } finally {
      provider.dispose()
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
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
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
  }
  const { runtime } = await loadProviderRuntime()
  const service = createSessionService({
    workspace: process.cwd(),
    modelPolicy: "required",
    modelBindingFor: providerModelBindingFor(runtime),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(coordinator !== undefined ? { sessionFor: createDurableSessionLoader(coordinator) } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    // M41b v1.1: rewind engine — the assembly creates the RewindStore +
    // RewindRecorder per session (keyed on sessionId) and records turns; the
    // rewindFactory below serves the rewind surface over that handle. Only
    // meaningful with a --session-dir (a store root to hang rewind/ under).
    ...(storeRoot !== undefined ? { rewindStoreRoot: storeRoot } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => (await coordinator.profile(id)).meta,
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
    const svc = new RewindService({
      store: assembly.rewind.store,
      workspace: workspaceRoot,
      // M58 R-B4 A: read-only git cross-check for plan().unseen.
      gitProbe: createGitProbeForStore(assembly.rewind.store, workspaceRoot),
    })
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
          // M58 R-B4 A: the read-only git evidence rides the wire additively.
          ...(plan.unseen !== undefined ? { unseen: plan.unseen } : {}),
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
    ...(coordinator !== undefined
      ? {
          createSession: async () => {
            const { id } = await coordinator.create()
            return { sessionId: id }
          },
          forkSession: async (sessionId: string) => {
            await coordinator.flush(sessionId)
            const result = await forkSession(coordinator, sessionId)
            return { sessionId: result.sessionId }
          },
          modelState: async (sessionId: string) => {
            const known = service.hasAssembly(sessionId) || (await coordinator.list()).includes(sessionId)
            if (!known) throw new Error(`session not found: ${sessionId}`)
            return service.modelState(sessionId)
          },
          setSessionModel: async (sessionId: string, selection: import("@i-harness/session-persistence").SessionModelSelection) => {
            const known = service.hasAssembly(sessionId) || (await coordinator.list()).includes(sessionId)
            if (!known) throw new Error(`session not found: ${sessionId}`)
            await coordinator.updateMeta(sessionId, { modelSelection: selection })
          },
        }
      : {}),
    // M41b v1.1: the rewind seam (wire-level "session-rewind" capability).
    // Present only with --session-dir (the assembly-side rewindStoreRoot chain
    // above); without it, every rewind method answers "rewind not enabled".
    ...(storeRoot !== undefined ? { rewindFactory: rewindFor } : {}),
    // M41a v1: session/list source — the store listing. M61: the ONE listing
    // implementation (shared with `i-harness sessions`) — a single corrupt or
    // missing file settles to a labelled row instead of failing the list, and
    // the failure is loud on stderr (stdout carries protocol frames only).
    listSessions:
      coordinator === undefined
        ? undefined
        : async () => {
            const rows = await listStoredSessions(coordinator, storeRoot!)
            for (const row of rows) {
              if (row.problem !== undefined) console.error(`[i-harness sdk] session list: "${row.id}": ${row.problem}`)
            }
            const sessions: SessionListEntry[] = rows.map((row) => ({
              id: row.id,
              ...(row.title !== undefined ? { title: row.title } : {}),
              ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
              ...(row.turnCount !== undefined ? { turnCount: row.turnCount } : {}),
            }))
            return { sessions }
          },
    onWrite: (message) => process.stdout.write(encodeFrame(message)),
    onShutdown: () => rl.close(),
  })

  let teardownPromise: Promise<void> | undefined
  const teardown = (): Promise<void> => teardownPromise ??= (async () => {
    rl.close()
    await server.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
  })()
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
    coordinator = createSessionCoordinator(createJsonlBackend(dir), { lock: { enabled: true, lockRoot: dir } })
  }
  const { runtime } = await loadProviderRuntime()
  const service = createSessionService({
    workspace: process.cwd(),
    modelPolicy: "required",
    modelBindingFor: providerModelBindingFor(runtime),
    ...(coordinator !== undefined ? { coordinator } : {}),
    ...(coordinator !== undefined ? { sessionFor: createDurableSessionLoader(coordinator) } : {}),
    ...(storeRoot !== undefined ? { sessionQuery: createFileBackedSessionQuery({ storeRoot }) } : {}),
    ...(coordinator !== undefined
      ? {
          loadMeta: async (id: string) => (await coordinator.profile(id)).meta,
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

  let teardownPromise: Promise<void> | undefined
  const teardown = (): Promise<void> => teardownPromise ??= (async () => {
    connection.close()
    await service.close()
    if (coordinator !== undefined) await coordinator.close()
  })()
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
  main(process.argv).then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
