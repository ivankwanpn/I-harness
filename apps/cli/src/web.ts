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
import { existsSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { append, type SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator, type SessionCoordinator, type SessionMeta } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createFileBackedSessionQuery } from "@i-harness/session-query"
import type { ModelClient } from "@i-harness/llm-seam"
import type { MockStep } from "@i-harness/llm-mock"
import { createSessionService, type ReasoningEffort, type SessionService } from "@i-harness/session-executor"
import {
  ApprovalMuxBridge,
  QuestionMuxBridge,
  createAuth,
  createWebHost,
  type CommandBridge,
  type CredentialStoreFace,
  type PluginRegistryFace,
  type PluginRuntimeView,
  type WebHost,
} from "@i-harness/web-host"
import {
  PluginRegistry,
  describeCommands,
  evaluatePlugin,
  inspectCapabilities,
  loadStateSync,
  mcpServerKey,
  readMcpServersSync,
} from "@i-harness/plugin-registry"
import { JobKillUnknownJobError } from "@i-harness/jobs"
import {
  createProviderRegistry,
  buildWireClient,
  resolveEffectiveModelContext,
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

// M27-H-1: the host's /api/health version — the CLI package's own version is
// the single constant (read at module load; the CLI is never bundled).
const require = createRequire(import.meta.url)
export const CLI_VERSION = (require("../package.json") as { version: string }).version

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
  /** Explicit plugin registry + its root (M40 A2). Absent → a fresh one rooted
   * at `<workspace>/.i-harness/plugins` — the host's /api/plugins routes serve
   * over it (catalog + runtime views + source/install/enable mutations). */
  pluginRegistry?: { registry: PluginRegistry; root: string }
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
  // M31 T1: settings model rows no longer FLATTEN into `models` id strings —
  // that dropped their contextWindow/maxTokens at the settings→provider seam
  // (the window chain never saw them). Aggregate the rows into `modelContexts`
  // (per-field USER WINS over profile.modelContexts) so the unified resolution
  // (resolveEffectiveModelContext / resolveModelContext) sees the settings
  // override; the base profile's `models` catalog stays as registered.
  // M32 T1 (FIX): maxTokens is the OUTPUT-LENGTH cap (SettingsModel.maxTokens
  // = the catalog's maxOutputTokens semantic) — it is NOT mapped into
  // modelContexts (the M31 maxTokens→maxContextWindow mapping is removed).
  // The settings row still carries it; the resolution chain's per-field
  // output-length override picks it up (resolveEffectiveModelContext).
  const modelContexts = { ...profile.modelContexts }
  for (const row of user.models ?? []) {
    if (row.contextWindow === undefined) continue
    modelContexts[row.id] = {
      ...modelContexts[row.id],
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    }
  }
  return {
    ...profile,
    apiKeyEnv: user.apiKeyEnv ?? profile.apiKeyEnv,
    baseUrl: user.baseURL ?? profile.baseUrl,
    ...(Object.keys(modelContexts).length > 0 ? { modelContexts } : {}),
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

// ── M40 A2: plugin seam composition ────────────────────────────────────────
// The host's PluginRegistryFace is an adapter contract — the raw registry's
// catalog() lacks the sources view and it has no runtime() — so the CLI
// composes the wrapper here (host.ts comment: "the embedder composes the
// seam"). Runtime observations are evaluated from the materialized overlays
// (skills/, commands/) plus the interaction catalog: the registry's own
// runtimeInputs() is what ENABLES plugins mount; the views here REPORT.
// v0 observation limits: connectedMcpServers = empty (no global MCP session
// set exists on the web path — plugin MCP mounts are per-assembly; a plugin
// declaring MCP reports mcp=failed until a host-global session set lands).
function createPluginRegistryFace(
  registry: PluginRegistry,
  root: string,
  commandNames: () => Set<string>,
): PluginRegistryFace {
  return {
    catalog: async () => {
      const [sources, catalog] = await Promise.all([registry.listSources(), registry.catalog()])
      return { sources, plugins: catalog.plugins }
    },
    runtime: (): PluginRuntimeView[] => {
      const state = loadStateSync(root)
      const names = commandNames()
      const views: PluginRuntimeView[] = []
      for (const rec of state.plugins) {
        const caps = inspectCapabilities(rec.installPath)
        const expectedCommandNames: string[] = [
          ...describeCommands(join(root, "commands", rec.id)).map((d) => d.name),
          ...(rec.conflicts ?? []).map((c) => c.name),
        ]
        const skillNamesByDir = new Map<string, string[]>()
        const skillDir = join(root, "skills", rec.id)
        if (existsSync(skillDir)) {
          const skillNames = readdirSync(skillDir, { withFileTypes: true })
            .filter((e) => e.name !== ".DS_Store")
            .map((e) => e.name)
          if (skillNames.length > 0) skillNamesByDir.set(rec.id, skillNames)
        }
        const expectedMcpServerNames = Object.keys(readMcpServersSync(rec.installPath)).map((s) => mcpServerKey(rec.id, s))
        const result = evaluatePlugin(rec, caps, {
          skillNamesByDir,
          commandNames: new Set(names),
          expectedCommandNames,
          expectedMcpServerNames,
          connectedMcpServers: new Set<string>(),
          initialized: true,
        })
        views.push({
          id: rec.id,
          enabled: rec.enabled,
          overall: result.overall,
          capabilities: result.capabilities,
          commandStatuses: result.commandStatuses,
        })
      }
      return views
    },
    addSource: async (source) => { await registry.addSource(source) },
    refreshSource: async (name) => { await registry.refreshSource(name) },
    removeSource: async (name) => { await registry.removeSource(name) },
    install: async (id) => { await registry.install(id) },
    uninstall: async (id) => { await registry.uninstall(id) },
    enable: async (id) => { await registry.enable(id) },
    disable: async (id) => { await registry.disable(id) },
  }
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

/** M27-R-A8 / M31 T3: the context window of the unified resolution chain
 * (user settings model row > profile.modelContexts[modelId] >
 * profile.contextWindow > undefined). Resolved against the SESSION tier
 * (meta.modelSelection) when present — the web path registers per session.
 * Unknown (mock / no registry entry) → undefined → get_context_remaining
 * fails closed (not registered). */
export function sessionContextWindow(opts: WebServerOptions, meta?: SessionMeta): number | undefined {
  const { spec } = resolveModelSpec(opts, meta)
  if (spec === "") return undefined
  const [providerName, modelId] = spec.split(":")
  const profile = opts.providerRegistry?.get(providerName)
  if (profile === undefined) return undefined
  const userModel = opts.settings
    ?.get().llm.providers[providerName]?.models
    ?.find((m) => m.id === modelId)
  return resolveEffectiveModelContext({ profile, modelId, userModel })?.contextWindow
}

/** M27-R-A8: the default chain's window (no per-session meta) — the legacy
 * single-value projection. The web path now resolves per session (see
 * sessionContextWindow / the service's contextWindowFor). */
export function defaultContextWindow(opts: WebServerOptions): number | undefined {
  return sessionContextWindow(opts)
}

export async function createWebServer(opts: WebServerOptions): Promise<WebServer> {
  const listenPort = Number.isFinite(opts.port) && opts.port >= 0 ? Math.floor(opts.port) : DEFAULT_WEB_PORT
  const coordinator: SessionCoordinator = createSessionCoordinator(createJsonlBackend(opts.workspace))
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
  // M40 A2: plugin seam — the default root sits under the workspace
  // (attachments/workspace convention); the face composes the registry's
  // catalog + runtime views for the host's /api/plugins routes.
  const pluginSeam = opts.pluginRegistry ?? {
    registry: new PluginRegistry({ root: join(opts.workspace, ".i-harness", "plugins") }),
    root: join(opts.workspace, ".i-harness", "plugins"),
  }
  const approvals = new ApprovalMuxBridge(hostCtx)
  approvals.attach()
  const questions = new QuestionMuxBridge(hostCtx)
  questions.attach()
  // M29: the store root is always known here (the workspace) — the file-backed
  // query derives the search/lineage surface out of the box (reconcile-on-
  // search, :memory: index per process).
  const sessionQuery = createFileBackedSessionQuery({ storeRoot: opts.workspace })
  const executor = createSessionService({
    workspace: opts.workspace,
    coordinator,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
    // The web path: job/status events mirror into the live session (the jobs
    // surface folds the durable doc; the mux streams carry the events).
    jobStatusEvents: true,
    sessionQuery,
    // M31 T3: per-session window knowledge — resolved at each assembly build
    // from the session's modelSelection through the unified chain (M27-R-A8
    // value was the static default chain; per-session selection now wins).
    contextWindowFor: (_sessionId, meta) => sessionContextWindow(opts, meta),
    // M32 T3: per-session reasoning effort — session.meta.modelSelection
    // .reasoningEffort (a string passthrough; type-cast to the effort union —
    // the adapter's translateReasoning owns the wire vocabulary, and an
    // unsupported value reaches the model end fail-loud). Absent selection →
    // undefined → the request never carries the field.
    reasoningEffortFor: (_sessionId, meta) =>
      meta?.modelSelection?.reasoningEffort as ReasoningEffort | undefined,
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
    // M29: the search/lineage HTTP routes now serve out of the box — the
    // file-backed index over the workspace's jsonl store (409 "not enabled"
    // only for embedders that never provide a seam).
    sessionQuery,
    approvalBridge: approvals,
    questionBridge: questions,
    commandBridge,
    settings,
    attachments,
    workspaceRegistry,
    modelSources: { settingsStore: settings, credentialStore: credentials, providerRegistry },
    // M40 A2: the plugin + jobs-kill seams — /api/plugins/* and
    // POST /api/sessions/:id/jobs/:jobId/kill stop answering 404.
    pluginRegistry: createPluginRegistryFace(
      pluginSeam.registry,
      pluginSeam.root,
      () => new Set(listCommands(hostCtx).map((c) => c.name)),
    ),
    jobKillBridge: {
      kill: async (sessionId, jobId) => {
        const assembly = await executor.assemblyFor(sessionId)
        try {
          return assembly.killJob(jobId)
        } catch {
          // The only failure the model-facing registry throws is an unknown
          // job id — mapped to the host's 409 contract (JobKillUnknownJobError).
          throw new JobKillUnknownJobError(jobId)
        }
      },
    },
    ...(auth !== undefined ? { auth } : {}),
    // M27-H-1: the health route's version — the CLI package.json constant.
    version: CLI_VERSION,
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
    },
  }
}

export async function runWebServer(opts: { port: number; workspace: string }): Promise<{ port: number }> {
  const server = await createWebServer(opts)
  console.log(`I-harness web: http://127.0.0.1:${server.port}`)
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
  await server.close()
  return { port: server.port }
}
