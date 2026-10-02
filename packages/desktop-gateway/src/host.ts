import { readFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, isAbsolute } from "node:path"
import { createFileProviderRuntime } from "@i-harness/provider-runtime/file"
import { deriveSessionTitle } from "@i-harness/core-session"
import { foldGoal } from "@i-harness/goal"
import { createIsolatedReviewerPool } from "@i-harness/guard-approval"
import { maybeAutoTitle } from "@i-harness/session-title"
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
import { createConversationVisibility, createConversationQuery, createSessionRuntimeVisibility } from "./session-visibility.ts"
import { createDesktopSubagents } from "./session-subagents.ts"
import { createDesktopRewind } from "./rewind.ts"
import { createDesktopPlugins } from "./plugins.ts"
import { pluginExtensions, expandPluginPrompt } from "./plugin-mount.ts"
import { createDesktopTerminal } from "./terminal.ts"
import { createDesktopSchedules } from "./schedules.ts"
import { createDesktopWorkState } from "./work-state.ts"
import { createAgentSettings } from "./agent-settings.ts"
import { createSubagentSettings } from "./subagent-settings.ts"
import { createHookSettings } from "./hook-settings.ts"
import { createDesktopMcp } from "./mcp-settings.ts"
import { createDesktopResources } from "./resources.ts"
import { createDesktopWorkflow, createDesktopGoalTools } from "./workflow.ts"
import { createDesktopApprovalHistory } from "./approval-history.ts"
import { createAgentShellSettings } from "./agent-shell.ts"
import { watchSettings } from "@i-harness/settings"
import { resolveHookTrustPath } from "@i-harness/hooks"
import { makeNotification, type RpcMessage } from "@i-harness/sdk"
import { createDesktopRouter, createGatewayWrite } from "./router.ts"
import { createInteractionBridge } from "./interaction.ts"
import { createProjectScopeBroker } from "./project-scope.ts"
import { createDesktopInput } from "./input.ts"
import { openInteractionPersistence } from "./interaction-persistence.ts"
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
const APPROVAL_MODES = new Set(["dangerous", "ask-all", "delegate", "full-access"])
const DESKTOP_GUARDIAN_POLICY = "Review every Agent tool call. Approve only clearly safe, in-scope actions. Return allow when a person should decide because the action is risky or uncertain. Deny clearly malicious or out-of-scope actions. Never execute a tool yourself."

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
  const approval = (parsed as { approvalMode?: unknown }).approvalMode
  if (approval !== undefined && (typeof approval !== "string" || !APPROVAL_MODES.has(approval))) throw new Error("invalid settings: unknown approvalMode")
  if (approval === "full-access" && mode !== "danger-full-access") {
    throw new Error("invalid settings: full access requires the full-access sandbox")
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
  let mode = settings.get().sandboxMode
  let approvalMode = settings.get().approvalMode
  const runtime = createFileProviderRuntime({ settingsPath, credentialsPath: options.credentialsPath ?? join(dirname(settingsPath), "credentials.json") })
  await mkdir(options.sessionDir, { recursive: true })
  const coordinator = createSessionCoordinator(createJsonlBackend(options.sessionDir), {
    lock: { enabled: true, lockRoot: options.sessionDir },
  })
  const compactionSignals = new Map<string, AbortSignal>()
  const isConversation = createConversationVisibility(coordinator)
  const projects = createProjectScopeBroker(coordinator, options.workspace, createSessionRuntimeVisibility(coordinator))
  const approvals = createDesktopApprovalHistory(coordinator)
  const reviewerPool = createIsolatedReviewerPool()
  const agentShell = createAgentShellSettings(settingsPath)
  const notifyWorkflow = (sessionId: string) => options.onWrite(makeNotification("desktop/workflow/changed", { sessionId }))
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
  const additionalTools = [...createMemoryTools(memory, () => memory.enabled()), ...createDesktopGoalTools((id) => service.liveSession(id), notifyWorkflow)]
  const plugins = createDesktopPlugins(join(dirname(settingsPath), "plugins"))
  const terminal = createDesktopTerminal(options.workspace)
  let roleModelsEnabled = settings.get().plugins.subagentModel
  let autoCompactionEnabled = settings.get().compaction.auto
  const subagents = createSubagentSettings(settingsPath, roleModelsEnabled, { onEnabledChanged(next) { roleModelsEnabled = next } })
  const mcpPath = join(dirname(settingsPath), "mcp-servers.json")
  const mcp = createDesktopMcp(mcpPath)
  const service: SessionService = createSessionService({
    projectContextFor: projects.forSession,
    agentShell: agentShell.resolve,
    team: {}, concurrentSessionTeams: true, jobStatusEvents: true,
    codeMode: settings.get().codeMode,
    additionalSystemPrompt(session) {
      const goal = foldGoal(session.events)
      return goal ? `Current goal (${goal.phase}, id ${goal.id}, revision ${goal.revision}): ${goal.objective}. ${goal.phase === "active" ? "Continue until fully achieved and verified, then call goal_complete with its current id/revision." : "Do not continue a paused or completed goal unless the user explicitly asks."}` : ""
    },
    roleSelectionFor: subagents.selectionFor,
    allowSubagentModelSelection: () => roleModelsEnabled,
    autoCompactionEnabled: () => autoCompactionEnabled,
    resolveRoleModel: (selection) => runtime.resolveModel({ sessionSelection: selection }),
    extensionsFor: async (id) => pluginExtensions(await plugins.inputs(), dirname(settingsPath), id, (messages) => plugins.report(id, messages), await mcp.active()),
    transformPrompt: expandPluginPrompt,
    rewindStoreRoot: options.sessionDir,
    additionalTools,
    sessionQuery,
    workspace: options.workspace,
    sandbox: mode,
    allowRuntimeSandboxChanges: true,
    approvalMode: () => approvalMode,
    guardian: { policy: DESKTOP_GUARDIAN_POLICY, enabled: () => approvalMode === "delegate", fallbackToHumanOnFailure: true, allowModelSelection: true, execution: "isolated", isolated: (sessionId) => ({
      pool: reviewerPool,
      permissionContext: () => `${options.workspace}\n${mode}\n${approvalMode}`,
      resolveBinding: async (selection) => {
        const fingerprint = async () => createHash("sha256").update(await readFile(settingsPath, "utf8").catch(() => "")).update(await readFile(options.credentialsPath ?? join(dirname(settingsPath), "credentials.json"), "utf8").catch(() => "")).digest("hex")
        const before = await fingerprint()
        const chosen = selection ?? (await coordinator.profile(sessionId)).meta.modelSelection
        const state = await runtime.resolveModel(chosen ? { sessionSelection: chosen } : {})
        if (state.status !== "ready") throw new Error(state.reason)
        const after = await fingerprint()
        return { client: state.binding.client, contextWindow: state.binding.contextWindow, maxOutputTokens: state.binding.maxOutputTokens,
          reasoningEffort: selection ? state.binding.reasoningEffort : undefined,
          identity: { provider: state.binding.providerId, model: state.binding.modelId, protocol: state.binding.protocol,
            ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}), ...(before === after ? { configurationKey: after } : {}) } }
      },
      onReview: async (record) => { await approvals.append(sessionId, record); notifyWorkflow(sessionId) },
    }) },
    modelPolicy: "required",
    modelBindingFor,
    afterSuccessfulSubmit: async (sessionId, assembly, limits) => {
      const { meta } = await coordinator.profile(sessionId)
      if (meta.title?.trim()) return
      await maybeAutoTitle({
        session: assembly.session,
        model: assembly.model,
        coordinator,
        sessionId,
        ...limits,
        // Some providers spend the first tokens on internal reasoning before
        // emitting title text. This remains far below a full session budget.
        titleMaxOutputTokens: 2_048,
        timeoutMs: 8_000,
      })
      const title = deriveSessionTitle(assembly.session)?.title
      if (!title) return
      await coordinator.flush(sessionId)
      const latest = await coordinator.profile(sessionId)
      if (!latest.meta.title?.trim()) await coordinator.updateMeta(sessionId, { title })
    },
    loadMeta: async (sessionId) => (await coordinator.profile(sessionId)).meta,
    coordinator,
    sessionFor: createDurableSessionLoader(coordinator),
    outputSpill: {},
    compact: { auto: settings.get().compaction.auto },
  })
  const input = createDesktopInput(coordinator, service, {
    prepare: async (id, text) => expandPluginPrompt(await service.assemblyFor(id), text),
    onStatus: (sessionId, running, error) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "failed" : "completed", ...(error ? { error } : {}) })),
  })
  const interaction = createInteractionBridge(options.onWrite, {
    approvalMode: () => approvalMode,
    persistence: await openInteractionPersistence(options.sessionDir, options.workspace),
    recover: async ({ request, inputId, text, signal }) => {
      signal.throwIfAborted()
      const admission = await input.admit(request.sessionId, { inputId, text, delivery: "queue", start: false })
      if (signal.aborted) await input.cancel(request.sessionId, admission.inputId)
      signal.throwIfAborted()
    },
  })
  const agentSettings = createAgentSettings(settingsPath, { sandboxMode: mode, autoCompaction: settings.get().compaction.auto, approvalMode }, {
    onSandboxModeChanged(next) { service.updateSandboxMode(next); mode = next },
    onApprovalModeChanged(next) { approvalMode = next },
    onAutoCompactionChanged(next) { autoCompactionEnabled = next },
  })
  const stopPluginObserver = plugins.bindRefresh(() => service.refreshExtensions())
  mcp.bindRefresh(() => plugins.refresh())
  const offInteraction = service.onAssembly((assembly) => interaction.attach(assembly))
  const sessionSubagents = createDesktopSubagents(coordinator, service, { onChanged: notifyWorkflow })
  const review = createWorkspaceReview(options.workspace)
  const workflow = createDesktopWorkflow(coordinator, service, { teamEnabled: true, reviews: approvals.read, onChanged: notifyWorkflow,
    onRunningChanged: (sessionId, running, error) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "failed" : "completed", ...(error ? { error } : {}) })) })
  const handlers: DesktopHandlers = {
    workflow, agentShell, input, projects,
    resources: createDesktopResources(options.workspace, () => plugins.inputs()),
    mcp,
    hooks: createHookSettings(dirname(settingsPath), async () => (await plugins.inputs()).hookConfigs, () => plugins.refresh()),
    subagents, sessionSubagents,
    agentSettings,
    terminal,
    schedules: createDesktopSchedules(coordinator, service),
    workState: createDesktopWorkState(coordinator, service, { sessionFor: async (id) => {
      const state = await service.modelState(id)
      return state.status === "ready" ? (await service.assemblyFor(id)).session : await createDurableSessionLoader(coordinator)(id)
    } }),
    plugins,
    rewind: createDesktopRewind(options.sessionDir, options.workspace, coordinator, service),
    sessions: createSessionManagement(coordinator, service, isConversation, { projectFor: projects.projectFor, onFork: projects.inherit }),
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
    sessionQuery: createConversationQuery(coordinator, sessionQuery),
    sandboxState: (): SandboxState => ({ mode, source: "settings", wired: true }),
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
        let conversation = false
        let title: string | undefined
        try {
          const { meta } = await coordinator.profile(id)
          if (meta.archived || !await isConversation(id, meta)) return undefined
          conversation = true; title = meta.title
          const session = service.liveSession(id) ?? (await (coordinator.snapshot?.(id) ?? coordinator.load(id))).session
          const turnCount = session.events.filter((event) => event.type === "turn/end").length
          return { id, turnCount, ...(meta.title === undefined ? {} : { title: meta.title }) }
        } catch {
          return conversation ? { id, ...(title ? { title } : {}) } : undefined
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
  let policySync: Promise<void> | undefined
  const syncPolicy = () => {
    if (closing || policySync) return
    // Both reads own settings file leases. An early failure must not release
    // shutdown's ownership of the other read while it can still create a lock.
    const job = Promise.allSettled([agentSettings.sync(), subagents.state()]).then((results) => {
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") console.warn(`[desktop] agent settings refresh failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`)
    })
    policySync = job
    void job.finally(() => { if (policySync === job) policySync = undefined })
  }
  const policyTimer = setInterval(syncPolicy, 1000)
  policyTimer.unref?.()
  syncPolicy()
  return {
    handleLine: (line) => router.handleLine(line),
    close: () => closing ??= (async () => {
      trustWatcher.dispose()
      clearInterval(policyTimer)
      interaction.close()
      await stopPluginObserver()
      terminal.close()
      offInteraction()
      await input.close()
      await router.close()
      await sessionSubagents.close()
      await projects.close()
      await review.close()
      await workflow.close()
      await service.close()
      await approvals.flush()
      await plugins.close()
      await policySync
      memory.close()
      await coordinator.close()
    })(),
  }
}
