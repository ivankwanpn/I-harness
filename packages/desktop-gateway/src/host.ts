import { readFile, mkdir } from "node:fs/promises"
import { dirname, join, isAbsolute } from "node:path"
import { createFileProviderRuntime } from "@i-harness/provider-runtime/file"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createFileBackedSessionQuery } from "@i-harness/session-query"
import { openMemoryStore, createMemoryTools } from "@i-harness/memory"
import type { SessionService } from "@i-harness/session-executor"
import { createDurableSessionLoader, createSessionService, type SessionServiceOptions } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { resolveSettingsPath, SettingsStore, PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"
import { commitModelSwitch } from "./model-switch.ts"
import { createSessionManagement } from "./session-management.ts"
import { createDesktopRewind } from "./rewind.ts"
import { createDesktopPlugins } from "./plugins.ts"
import { pluginExtensions, expandPluginPrompt } from "./plugin-mount.ts"
import { createDesktopTerminal } from "./terminal.ts"
import { createAgentSettings } from "./agent-settings.ts"
import { createSubagentSettings } from "./subagent-settings.ts"
import { createHookSettings } from "./hook-settings.ts"
import { createDesktopMcp } from "./mcp-settings.ts"
import { createDesktopResources } from "./resources.ts"
import { watchSettings } from "@i-harness/settings"
import { resolveHookTrustPath } from "@i-harness/hooks"
import type { RpcMessage } from "@i-harness/sdk"
import { createDesktopRouter, createGatewayWrite } from "./router.ts"
import { createInteractionBridge } from "./interaction.ts"
import { createWorkspaceReview } from "./review.ts"
import type { DesktopHandlers, SandboxState } from "./types.ts"

export interface DesktopHostOptions {
  workspace: string
  sessionDir: string
  settingsPath?: string
  credentialsPath?: string
  onWrite: (frame: RpcMessage) => void
}

export interface DesktopHost {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
}

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"])

/** SettingsStore intentionally falls back on corrupt JSON; a host claiming a
 * configured sandbox must distinguish a first run from a damaged document. */
async function validateSettingsDocument(path: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`invalid settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("invalid settings: JSON parse failed")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid settings: expected an object")
  }
  const mode = (parsed as { sandboxMode?: unknown }).sandboxMode
  if (mode !== undefined && (typeof mode !== "string" || !SANDBOX_MODES.has(mode))) {
    throw new Error("invalid settings: unknown sandboxMode")
  }
}

export async function createDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  if (!isAbsolute(options.workspace) || !isAbsolute(options.sessionDir)) {
    throw new Error("workspace and sessionDir must be absolute paths")
  }
  const settingsPath = resolveSettingsPath(options.settingsPath === undefined ? {} : { path: options.settingsPath })
  await validateSettingsDocument(settingsPath)
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  const mode = settings.get().sandboxMode
  const sandboxState: SandboxState = { mode, source: "settings", wired: true }
  const runtime = createFileProviderRuntime({ settingsPath, credentialsPath: options.credentialsPath ?? join(dirname(settingsPath), "credentials.json") })
  await mkdir(options.sessionDir, { recursive: true })
  const coordinator = createSessionCoordinator(createJsonlBackend(options.sessionDir), {
    lock: { enabled: true, lockRoot: options.sessionDir },
  })
  const compactionSignals = new Map<string, AbortSignal>()
  const modelBindingFor: NonNullable<SessionServiceOptions["modelBindingFor"]> = async (sessionId, meta) => {
    const state = await runtime.resolveModel(meta?.modelSelection === undefined
      ? {}
      : { sessionSelection: meta.modelSelection })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { ...binding, model: {
      stream(request) {
        const compactSignal = compactionSignals.get(sessionId)
        const signal = compactSignal && request.signal
          ? AbortSignal.any([compactSignal, request.signal])
          : compactSignal ?? request.signal
        signal?.throwIfAborted()
        return client.stream({ ...request, ...(signal ? { signal } : {}) })
      },
    } } }
  }
  // The derived in-memory search index belongs to this workspace gateway
  // process. Never call global query cleanup when closing an individual host.
  const sessionQuery = createFileBackedSessionQuery({ storeRoot: options.sessionDir })
  const memory = openMemoryStore({ path: join(options.sessionDir, "memory.sqlite"), scope: options.workspace })
  const additionalTools = createMemoryTools(memory, () => memory.enabled())
  const plugins = createDesktopPlugins(join(dirname(settingsPath), "plugins"))
  const terminal = createDesktopTerminal(options.workspace)
  const subagents = createSubagentSettings(settingsPath, settings.get().plugins.subagentModel)
  const mcpPath = join(dirname(settingsPath), "mcp-servers.json")
  const mcp = createDesktopMcp(mcpPath)
  const service: SessionService = createSessionService({
    roleSelectionFor: subagents.selectionFor,
    allowSubagentModelSelection: settings.get().plugins.subagentModel,
    resolveRoleModel: (selection) => runtime.resolveModel({ sessionSelection: selection }),
    extensionsFor: async (id) => pluginExtensions(await plugins.inputs(), dirname(settingsPath), id, (messages) => plugins.report(id, messages), await mcp.active()),
    transformPrompt: expandPluginPrompt,
    rewindStoreRoot: options.sessionDir,
    additionalTools,
    sessionQuery,
    workspace: options.workspace,
    sandbox: mode,
    modelPolicy: "required",
    modelBindingFor,
    loadMeta: async (sessionId) => (await coordinator.profile(sessionId)).meta,
    coordinator,
    sessionFor: createDurableSessionLoader(coordinator),
    outputSpill: {},
    compact: { auto: settings.get().compaction.auto },
  })
  const interaction = createInteractionBridge(options.onWrite)
  const stopPluginObserver = plugins.bindRefresh(() => service.refreshExtensions())
  mcp.bindRefresh(() => plugins.refresh())
  const offInteraction = service.onAssembly((assembly) => interaction.attach(assembly))
  const review = createWorkspaceReview(options.workspace)
  const handlers: DesktopHandlers = {
    resources: createDesktopResources(options.workspace, () => plugins.inputs()),
    mcp,
    hooks: createHookSettings(dirname(settingsPath), async () => (await plugins.inputs()).hookConfigs, () => plugins.refresh()),
    subagents,
    agentSettings: createAgentSettings(settingsPath, { sandboxMode: mode, autoCompaction: settings.get().compaction.auto }),
    terminal,
    plugins,
    rewind: createDesktopRewind(options.sessionDir, options.workspace, coordinator, service),
    sessions: createSessionManagement(coordinator, service),
    provider: runtime,
    memory,
    compact: async (sessionId, instructions, signal) => {
      signal.throwIfAborted()
      await coordinator.profile(sessionId)
      const state = service.queueState(sessionId)
      if (state.running || state.queued > 0) throw new Error("session is busy")
      compactionSignals.set(sessionId, signal)
      try {
        const assembly = await service.assemblyFor(sessionId)
        signal.throwIfAborted()
        const result = await assembly.compactNow(instructions)
        await coordinator.flush(sessionId)
        return result
      } finally { compactionSignals.delete(sessionId) }
    },
    sessionQuery,
    sandboxState: () => sandboxState,
    interaction,
    review,
  }
  const internalIds = new Set<string>()
  const base = createSdkServer(service, {
    coordinator,
    modelState: async (sessionId) => {
      await coordinator.profile(sessionId)
      return service.modelState(sessionId)
    },
    setSessionModel: async (sessionId, selection) => {
      const { meta } = await coordinator.profile(sessionId)
      if (selection.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly string[]).includes(selection.protocol)) throw new Error("Invalid model protocol")
      const durable = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) }
      const transient = { ...durable, ...(selection.protocol !== undefined ? { protocol: selection.protocol as SettingsProviderProtocol } : {}) }
      const state = await modelBindingFor(sessionId, { ...meta, modelSelection: transient })
      if (state.status !== "ready") throw new Error(state.reason)
      await commitModelSwitch(service, sessionId, state.binding, () => coordinator.updateMeta(sessionId, { modelSelection: durable }))
    },
    createSession: async () => ({ sessionId: (await coordinator.create()).id }),
    listSessions: async () => {
      const ids = await coordinator.list()
      const sessions = await Promise.all(ids.map(async (id) => {
        try {
          const { meta } = await coordinator.profile(id)
          if (meta.archived) return undefined
          return { id, ...(meta.title === undefined ? {} : { title: meta.title }) }
        } catch {
          return { id }
        }
      }))
      return { sessions: sessions.filter((row) => row !== undefined) }
    },
    onWrite: createGatewayWrite(options.onWrite, handlers, internalIds),
  })
  const router = createDesktopRouter(base, options.onWrite, handlers, internalIds)
  let closing: Promise<void> | undefined
  const trustWatcher = watchSettings([resolveHookTrustPath(dirname(settingsPath)), mcpPath], () => {
    if (!closing) void mcp.refresh().catch(() => { /* Settings surfaces expose live refresh failures. */ })
  })
  return {
    handleLine: (line) => router.handleLine(line),
    close: () => closing ??= (async () => {
      trustWatcher.dispose()
      interaction.close()
      await stopPluginObserver()
      terminal.close()
      offInteraction()
      await router.close()
      await review.close()
      await service.close()
      await plugins.close()
      memory.close()
      await coordinator.close()
    })(),
  }
}
