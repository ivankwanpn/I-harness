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
import type { SessionService, SessionProjectContext } from "@i-harness/session-executor"
import { createDurableSessionLoader, createSessionService, type SessionServiceOptions } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { resolveSettingsPath, SettingsStore, PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"
import { commitModelSwitch } from "./model-switch.ts"
import { createSessionManagement } from "./session-management.ts"
import { createContextPicker } from "./context-picker.ts"
import { createDraftSession } from "./draft-session.ts"
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
import { createEffectiveLocalInputs } from "./effective-local-inputs.ts"
import { createProjectFiles } from "./project-files.ts"
import { createSessionManagementFence } from "./session-management-fence.ts"
import { createCodeModeSettings, createDesktopExecution } from "./execution.ts"
import { createAgentProcesses } from "./agent-processes.ts"
import { createDesktopDiagnostics } from "./environment-diagnostics.ts"
import { createApprovalRulesAdapter } from "./approval-rules.ts"
import { approvalPolicyIdentity } from "./approval-policy-identity.ts"
import { createAutoTitleSettings } from "./auto-title.ts"
import type { RuntimeInputs } from "@i-harness/plugin-registry"
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
  const fence = createSessionManagementFence()
  let management: ReturnType<typeof createSessionManagement>
  const drainSession = async (id: string) => { await service.closeSession(id); await approvals.flush() }
  const projects = createProjectScopeBroker(coordinator, options.workspace, createSessionRuntimeVisibility(coordinator), { fence, assertIdle: id => management.assertIdle(id), drainSession })
  const projectContexts = new Map<string, () => SessionProjectContext | undefined>()
  const extensionInputs = new Map<string, RuntimeInputs>()
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
  const autoTitle = createAutoTitleSettings(settingsPath)
  const approvalRules = createApprovalRulesAdapter({ filePath: join(options.sessionDir, "approval-rules-v1.json"), policyIdentity: assembly => {
    const project = assembly.sessionId ? projectContexts.get(assembly.sessionId) : undefined
    const inputs = assembly.sessionId ? extensionInputs.get(assembly.sessionId) : undefined
    return project && inputs ? approvalPolicyIdentity(assembly, { workspace: options.workspace, sandbox: mode, approval: approvalMode, project,
      hookConfigs: inputs.hookConfigs, grantPaths: [resolveHookTrustPath(dirname(settingsPath)), join(dirname(settingsPath), "hook-authoring-grants.json")], pluginAuthority: inputs }) : undefined
  } })
  const service: SessionService = createSessionService({
    sessionOperation: fence,
    projectContextFor: async id => { const getter = await projects.forSession(id); projectContexts.set(id, getter); return getter },
    agentShell: agentShell.resolve,
    team: {}, concurrentSessionTeams: true, jobStatusEvents: true,
    codeMode: () => codeSettings.resolve(),
    additionalSystemPrompt(session) {
      const goal = foldGoal(session.events)
      return goal ? `Current goal (${goal.phase}, id ${goal.id}, revision ${goal.revision}): ${goal.objective}. ${goal.phase === "active" ? "Continue until fully achieved and verified, then call goal_complete with its current id/revision." : "Do not continue a paused or completed goal unless the user explicitly asks."}` : ""
    },
    roleSelectionFor: subagents.selectionFor,
    allowSubagentModelSelection: () => roleModelsEnabled,
    autoCompactionEnabled: () => autoCompactionEnabled,
    resolveRoleModel: (selection) => runtime.resolveModel({ sessionSelection: selection }),
    extensionsFor: async (id) => { const inputs = await createEffectiveLocalInputs(options.workspace, dirname(settingsPath), await plugins.inputs()); extensionInputs.set(id, inputs); return pluginExtensions(inputs, dirname(settingsPath), id, (messages) => plugins.report(id, messages), await mcp.active()) },
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
      if (!autoTitle.enabled()) return
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
  const codeSettings = createCodeModeSettings(settingsPath, service)
  const rawInput = createDesktopInput(coordinator, service, {
    prepare: async (id, text) => expandPluginPrompt(await service.assemblyFor(id), text),
    onStatus: (sessionId, running, error) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "failed" : "completed", ...(error ? { error } : {}) })),
  })
  const input = { ...rawInput, admit: (id: string, raw: Parameters<typeof rawInput.admit>[1]) => fence.run(id, () => rawInput.admit(id, raw)),
    resume: (id: string) => fence.run(id, () => rawInput.resume(id)), cancel: (id: string, inputId: string) => fence.run(id, () => rawInput.cancel(id, inputId)) }
  const interaction = createInteractionBridge(options.onWrite, {
    approvalRules,
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
  const rawWorkflow = createDesktopWorkflow(coordinator, service, { teamEnabled: true, reviews: approvals.read, onChanged: notifyWorkflow,
    onRunningChanged: (sessionId, running, error) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "failed" : "completed", ...(error ? { error } : {}) })) })
  const workflow = { ...rawWorkflow, mutate: (id: string, command: unknown) => fence.run(id, () => rawWorkflow.mutate(id, command)) }
  management = createSessionManagement(coordinator, service, isConversation, { workspace: options.workspace, sessionDir: options.sessionDir, fence,
    projectFor: projects.projectFor, onFork: projects.inherit, moveProject: projects.move, pendingInteractions: async id => interaction.pending(id),
    activeWork: async id => (await workflow.read(id)).goalRun?.running === true, drainSession })
  const schedules = createDesktopSchedules(coordinator, service)
  const rewind = createDesktopRewind(options.sessionDir, options.workspace, coordinator, service)
  const workState = createDesktopWorkState(coordinator, service, { sessionFor: async (id) => {
    const state = await service.modelState(id)
    return state.status === "ready" ? (await service.assemblyFor(id)).session : await createDurableSessionLoader(coordinator)(id)
  } })
  const execution = createDesktopExecution(coordinator, service)
  const agentProcesses = createAgentProcesses(coordinator, service)
  const resources = createDesktopResources(options.workspace, () => plugins.inputs(), { configDir: dirname(settingsPath), refresh: () => service.refreshExtensions() })
  const handlers: DesktopHandlers = {
    workspace: options.workspace, autoTitle, codeSettings, approvalRules,
    assertSession: async id => { const { meta } = await coordinator.profile(id); if (!await isConversation(id, meta)) throw new Error("Conversation unavailable") },
    execution: { ...execution, stop: (id, cellId) => fence.run(id, () => execution.stop(id, cellId)) },
    agentProcesses: { ...agentProcesses, control: (id, command) => fence.run(id, () => agentProcesses.control(id, command)) },
    diagnostics: createDesktopDiagnostics(service, { shell: agentShell }),
    draftSession: createDraftSession(coordinator),
    contextPicker: createContextPicker(options.workspace, coordinator, review, { visible: isConversation, projectFor: projects.projectFor, query: createConversationQuery(coordinator, sessionQuery) }),
    workflow, agentShell, input, projects: { ...projects, bind: (id, projectId) => fence.run(id, () => projects.bind(id, projectId)) },
    resources,
    projectFiles: createProjectFiles(options.workspace, review),
    mcp,
    hooks: createHookSettings(dirname(settingsPath), async () => (await createEffectiveLocalInputs(options.workspace, dirname(settingsPath), await plugins.inputs())).hookConfigs, () => service.refreshExtensions(), { workspace: options.workspace }),
    subagents, sessionSubagents,
    agentSettings,
    terminal,
    schedules: { ...schedules, create: (id, command) => fence.run(id, () => schedules.create(id, command)), delete: (id, scheduleId) => fence.run(id, () => schedules.delete(id, scheduleId)) },
    workState: { ...workState, writeTodos: (id, command) => fence.run(id, () => workState.writeTodos(id, command)) },
    plugins: { ...plugins, commands: async () => (await resources.effectiveInputs()).commandDescriptors.map(({ name, description, argumentHints }) => ({ name, description, argumentHints })) },
    rewind: { ...rewind, execute: (id, target, mode, fingerprint) => fence.run(id, () => rewind.execute(id, target, mode, fingerprint)) },
    sessions: { ...management, batch: async command => { const result = await management.batch(command); if (command.action === "delete") for (const row of result.results) if (row.ok) approvalRules.removeSession(row.sessionId); return result },
      mutate: async (id, action, title) => { const result = await management.mutate(id, action, title); if (action === "delete") approvalRules.removeSession(id); return result } },
    provider: runtime,
    memory,
    compact: (sessionId, instructions, signal) => fence.run(sessionId, async () => {
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
    }),
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
    setSessionModel: (sessionId, selection) => fence.run(sessionId, async () => {
      const { meta } = await coordinator.profile(sessionId)
      if (selection.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly string[]).includes(selection.protocol)) throw new Error("Invalid model protocol")
      const durable = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) }
      const transient = { ...durable, ...(selection.protocol !== undefined ? { protocol: selection.protocol as SettingsProviderProtocol } : {}) }
      const state = await modelBindingFor(sessionId, { ...meta, modelSelection: transient })
      if (state.status !== "ready") throw new Error(state.reason)
      await commitModelSwitch(service, sessionId, state.binding, () => coordinator.updateMeta(sessionId, { modelSelection: durable }))
    }),
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
