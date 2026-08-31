// Thin web composition (R-C0 engine-owned): the runHeadless assembly lives in
// @i-harness/session-executor; @i-harness/web-host is transport-only. This
// file wires the two, composes the seams the host serves (approvals,
// questions, commands, auth, model sources), and owns the process lifecycle.
// The branch's 1,598-line glue (web.ts + live-agent.ts) is NOT recreated.
//
// M26 adaptation: the E-region packages (settings/credentials/workspace/
// provider) are REAL — the model-sources seam and the model chain are
// composed here directly (the plan's E-flip is the port itself), so the
// host's settings/credentials/llm/models route family activates.
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { append, type SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator, type SessionCoordinator, type SessionMeta } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend, closeSqliteBackends } from "@i-harness/session-persistence-sqlite"
import type { ModelClient } from "@i-harness/llm-seam"
import type { MockStep } from "@i-harness/llm-mock"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import {
  ApprovalMuxBridge,
  QuestionMuxBridge,
  createAuth,
  createWebHost,
  type CommandBridge,
  type CredentialStoreFace,
  type WebHost,
} from "@i-harness/web-host"
import {
  createProviderRegistry,
  buildWireClient,
  type ProviderRegistry,
  type ProviderProfile,
} from "@i-harness/provider"
import {
  SettingsStore,
  SETTINGS_DEFAULTS,
  resolveProviderProtocol,
  resolveSettingsPath,
  type SettingsProviderConfig,
  type SettingsSandboxMode,
  type SettingsTheme,
} from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createImageAttachmentStore, type ImageAttachmentStore } from "@i-harness/attachment"
import { createWorkspaceRegistry } from "@i-harness/workspace"
import { registerCommand, listCommands, parseCommandLine, runCommand } from "@i-harness/interaction"

export const DEFAULT_WEB_PORT = 4310

/**
 * PORT parsing (review fix): `Number(process.env.PORT)` is NaN for PORT=abc,
 * and listen(NaN) throws. Unset / empty / non-finite / negative values fall
 * back to the default; valid values are floored. PORT=0 stays valid
 * (OS-assigned port).
 */
export function parsePort(raw: string | undefined, fallback = DEFAULT_WEB_PORT): number {
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

export interface WebServerOptions {
  port: number
  workspace: string
  /** Session persistence backend; `sqlite` is the FTS5 precondition that
   * unlocks the host's search/lineage endpoints. */
  sessionBackend?: "jsonl" | "sqlite"
  /** Explicit model client. Absent → the resolution chain, then the mock. */
  model?: ModelClient
  /** Mock script used when no real model resolves. */
  mockScript?: MockStep[]
  /** Explicit settings store. Absent → `~/.i-harness/settings.json` (dsh parity). */
  settings?: SettingsStore
  /** Explicit image attachment store. Absent → over `<workspace>/.i-harness/attachments`. */
  attachments?: ImageAttachmentStore
  /** Explicit credential store. Absent → `<config-dir>/credentials.json`
   * (config dir = the settings one, single-sourced). */
  credentials?: CredentialStoreFace
  /** Explicit provider registry. Absent → a FRESH EMPTY registry (amendment:
   * no built-in profiles — every provider is settings-managed). */
  providerRegistry?: ProviderRegistry
  /** Auth: enable by passing EITHER (a missing half is randomized at start). */
  auth?: { launchToken?: string; hmacSecret?: string }
  /** Print the login URL (with the launch token) at startup. */
  printLoginUrl?: boolean
}

export interface WebServer {
  host: WebHost
  port: number
  executor: SessionService
  close(): Promise<void>
}

// ── model chain (pure; ported from the abandoned branch's web.ts) ───────────
interface ModelResolution { spec: string; source: "session" | "default" | "legacy" | "mock" }

export function resolveModelSpec(opts: WebServerOptions, meta?: SessionMeta): ModelResolution {
  const selection = meta?.modelSelection
  if (selection !== undefined
    && typeof selection.provider === "string" && selection.provider !== ""
    && typeof selection.model === "string" && selection.model !== "") {
    return { spec: `${selection.provider}:${selection.model}`, source: "session" }
  }
  const settings = opts.settings
  if (settings !== undefined) {
    const dm = settings.get().llm.defaultModel
    const seed = SETTINGS_DEFAULTS.llm.defaultModel
    const isSeedDefault = dm.provider === seed.provider && dm.model === seed.model
      && (dm.reasoningEffort ?? undefined) === (seed.reasoningEffort ?? undefined)
    if (!isSeedDefault && dm.provider !== "" && dm.model !== "") {
      return { spec: `${dm.provider}:${dm.model}`, source: "default" }
    }
  }
  const legacy = settings?.get().model
  if (legacy !== undefined && legacy !== "") {
    return { spec: legacy, source: "legacy" }
  }
  return { spec: "", source: "mock" }
}

export function buildAdapterForRoute(
  route: string,
  user: SettingsProviderConfig | undefined,
  profile: ProviderProfile | undefined,
  model: string | undefined,
  apiKey: string,
): ModelClient | undefined {
  const protocol = resolveProviderProtocol(route, user)
  const resolvedModel = model ?? profile?.defaultModel ?? "gpt-4o"
  const client = buildWireClient(protocol, {
    model: resolvedModel,
    apiKey,
    baseUrl: user?.baseURL ?? profile?.baseUrl,
    ...(profile?.inputModalities !== undefined ? { inputModalities: profile.inputModalities } : {}),
  })
  if (client === undefined) {
    console.warn(
      `[i-harness] model "${route}:${resolvedModel}" unresolved — unknown protocol "${protocol}", falling back to the mock`,
    )
    return undefined
  }
  return client
}

export function effectiveProviderProfile(
  profile: ProviderProfile,
  user: SettingsProviderConfig,
): ProviderProfile {
  return {
    ...profile,
    apiKeyEnv: user.apiKeyEnv ?? profile.apiKeyEnv,
    baseUrl: user.baseURL ?? profile.baseUrl,
    ...(user.models !== undefined && user.models.length > 0
      ? { models: user.models.map((m) => m.id) }
      : {}),
  }
}

async function resolveModelProvider(
  spec: string,
  registry: ProviderRegistry | undefined,
  userConfig: SettingsProviderConfig | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [providerName] = spec.split(":")
  if (userConfig !== undefined) return { ok: true }
  if (registry !== undefined && registry.get(providerName) !== undefined) return { ok: true }
  return { ok: false, error: `unknown model provider: ${providerName}` }
}

/** The tier chain: session.meta.modelSelection > llm.defaultModel > legacy
 * model > mock. An unresolved any-tier spec warns and falls back to undefined
 * (the mock — the web server never REQUIRES an API key). */
async function buildModelFor(opts: WebServerOptions, meta?: SessionMeta): Promise<ModelClient | undefined> {
  if (opts.model !== undefined) return opts.model
  const { spec, source } = resolveModelSpec(opts, meta)
  if (spec === "") return undefined
  const [providerName] = spec.split(":")
  const registry = opts.providerRegistry
  if (registry === undefined) return undefined
  const userConfig = opts.settings?.get().llm.providers[providerName]
  const check = await resolveModelProvider(spec, registry, userConfig)
  if (!check.ok) {
    console.warn(
      `[i-harness] model "${spec}" (${source}) unresolved — 尚未配置模型（falling back to the mock）: ${check.error}`,
    )
    return undefined
  }
  const baseProfile = registry.get(providerName)
  const profile = baseProfile !== undefined && userConfig !== undefined
    ? effectiveProviderProfile(baseProfile, userConfig)
    : baseProfile
  const envName = userConfig?.apiKeyEnv ?? profile?.apiKeyEnv
  const apiKey = envName !== undefined
    ? opts.credentials?.resolve?.(envName) ?? process.env[envName]
    : undefined
  if (apiKey === undefined || apiKey === "") return undefined
  try {
    return buildAdapterForRoute(providerName, userConfig, profile, spec.split(":")[1], apiKey)
  } catch (error) {
    console.warn(
      `[i-harness] model "${spec}" (${source}) unresolved — falling back to the mock: `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
}

// ── default commands (DSH parity minimal set; the web command palette) ──────
const THEME_VALUES: readonly SettingsTheme[] = ["light", "dark", "system"]
const SANDBOX_VALUES: readonly SettingsSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]
const MODEL_SPEC_RE = /^[a-z][a-z0-9_-]*:[a-zA-Z0-9._-]+$/

function registerDefaultCommands(target: PluginContext, settings: SettingsStore, registry: ProviderRegistry): void {
  registerCommand(target, {
    name: "theme",
    description: "切换主题：/theme light|dark|system",
    execute: async (input) => {
      const theme = input.trim()
      if (!THEME_VALUES.includes(theme as SettingsTheme)) throw new Error("用法: /theme light|dark|system")
      await settings.set({ theme: theme as SettingsTheme })
      return `主题已切换为 ${theme}`
    },
  })
  registerCommand(target, {
    name: "sandbox",
    description: "沙箱模式：/sandbox read-only|workspace-write|danger-full-access",
    execute: async (input) => {
      const mode = input.trim()
      if (!SANDBOX_VALUES.includes(mode as SettingsSandboxMode)) throw new Error("用法: /sandbox read-only|workspace-write|danger-full-access")
      await settings.set({ sandboxMode: mode as SettingsSandboxMode })
      return `沙箱模式已设为 ${mode}（随后创建的会话生效）`
    },
  })
  registerCommand(target, {
    name: "model",
    description: "默认模型：/model provider:model（请先到设置添加提供方）",
    execute: async (input) => {
      const spec = input.trim()
      if (!MODEL_SPEC_RE.test(spec)) throw new Error("用法: /model provider:model（请先到设置添加提供方）")
      const check = await resolveModelProvider(spec, registry, settings.get().llm.providers[spec.split(":")[0]!])
      if (!check.ok) throw new Error(`/model 未生效：请先到设置添加提供方（${check.error}）`)
      await settings.set({ model: spec })
      return `默认模型已设为 ${spec}（新建会话生效）`
    },
  })
}

/** Append the UI-plane command run/done pair to the session's LIVE log
 * (best-effort — the events are model-invisible and never break the command). */
function appendCommandEvents(executor: SessionService, sessionId: string, name: string, args: string | undefined, commandId: string, phase: "run" | "done", text?: string): void {
  void executor.assemblyFor(sessionId).then((a) => {
    append(a.session, (phase === "run"
      ? { type: "command/run", commandId, name, ...(args !== undefined ? { args } : {}), source: { kind: "user" } }
      : { type: "command/done", commandId, kind: "success", ...(text !== undefined ? { text } : {}) }) as SessionEvent)
  }).catch(() => {})
}

export async function createWebServer(opts: WebServerOptions): Promise<WebServer> {
  const listenPort = Number.isFinite(opts.port) && opts.port >= 0 ? Math.floor(opts.port) : DEFAULT_WEB_PORT
  const coordinator: SessionCoordinator =
    (opts.sessionBackend ?? "jsonl") === "sqlite"
      ? createSessionCoordinator(createSqliteBackend(join(opts.workspace, "sessions.db")))
      : createSessionCoordinator(createJsonlBackend(opts.workspace))
  // E-region seams for the host (optional pieces — the routes 404 per absent
  // piece, so an API-only embedder stays unchanged).
  const settings = opts.settings ?? new SettingsStore()
  await settings.load()
  const credentials = opts.credentials ?? createCredentialStore(
    join(dirname(resolveSettingsPath()), "credentials.json"),
  )
  const providerRegistry = opts.providerRegistry ?? createProviderRegistry()
  const attachments = opts.attachments ?? createImageAttachmentStore({ workspaceDir: opts.workspace })
  const workspaceRegistry = createWorkspaceRegistry(coordinator)

  const hostCtx: PluginContext = createContext()
  registerDefaultCommands(hostCtx, settings, providerRegistry)
  const approvals = new ApprovalMuxBridge(hostCtx)
  approvals.attach()
  const questions = new QuestionMuxBridge(hostCtx)
  questions.attach()
  const executor = createSessionService({
    workspace: opts.workspace,
    coordinator,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
    // The web path: job/status events mirror into the live session (the jobs
    // surface folds the durable doc; the mux streams carry the events).
    jobStatusEvents: true,
    loadMeta: async (id) => (await coordinator.profile(id)).meta,
    modelBuilder: async (_sessionId, meta) => buildModelFor(opts, meta),
  })
  const commandBridge: CommandBridge = {
    list: () => listCommands(hostCtx),
    run: async (sessionId, line, signal) => {
      const parsed = parseCommandLine(line)
      if (parsed === undefined) throw new Error(`not a command line: "${line}"`)
      const commandId = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      appendCommandEvents(executor, sessionId, parsed.name, parsed.input === "" ? undefined : parsed.input, commandId, "run")
      const result = await runCommand(hostCtx, parsed.name, parsed.input)
      if (!signal.aborted) appendCommandEvents(executor, sessionId, parsed.name, undefined, commandId, "done", result)
      return result
    },
  }
  const auth = opts.auth === undefined ? undefined : createAuth({
    hmacSecret: opts.auth.hmacSecret ?? randomBytes(32).toString("hex"),
    launchToken: opts.auth.launchToken ?? randomBytes(24).toString("base64url"),
  })
  const host = createWebHost({
    port: listenPort,
    executor,
    coordinator,
    approvalBridge: approvals,
    questionBridge: questions,
    commandBridge,
    settings,
    attachments,
    workspaceRegistry,
    modelSources: { settingsStore: settings, credentialStore: credentials, providerRegistry },
    ...(auth !== undefined ? { auth } : {}),
  })
  executor.onAssembly((a) => {
    if (a.sessionId === undefined) return
    // Bridge attach point: approvals/questions from ANY session flow into the
    // shared mux streams (the failsafe attach is the bridge's own ctx — the
    // session-level attach is what actually carries their asks).
    approvals.attach(a.ctx)
    questions.attach(a.ctx)
    host.attachLiveSession({ sessionId: a.sessionId, session: a.session })
  })
  const { port: listeningPort } = await host.listen()
  if (auth !== undefined && opts.printLoginUrl) {
    console.log(`I-harness web login: http://127.0.0.1:${listeningPort}/api/auth/login?token=${auth.launchToken()}`)
  }
  return {
    host,
    port: listeningPort,
    executor,
    close: async () => {
      await host.close()
      await executor.close()
      if (opts.sessionBackend === "sqlite") closeSqliteBackends()
    },
  }
}

export async function runWebServer(opts: { port: number; workspace: string; sessionBackend?: "jsonl" | "sqlite" }): Promise<{ port: number }> {
  const server = await createWebServer(opts)
  console.log(`I-harness web: http://127.0.0.1:${server.port}`)
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
  await server.close()
  return { port: server.port }
}
