import { createRetainedCleanupOperation, finishRetainedCleanupOperation, closeCoordinatorWithRetainedCleanupOperation } from '@i-harness/session-persistence/internal/retained-inspection'
import { createAgentProcessReadRunner } from './agent-process-read.ts'
import type { ContextResultRef } from "@i-harness/context-output"
import type { ManagedArtifactRef } from "@i-harness/core-session"
import { createModelWaitSettings } from "./model-wait-settings.ts"
import { readFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, isAbsolute } from "node:path"
import { createFileProviderRuntime, type FileProviderRuntimeOptions } from "@i-harness/provider-runtime/file"
import { buildModelClient } from "@i-harness/provider"
import { prepareModelRequest, withPreparedSignal, snapshotModelData, type LLMRequest, type ModelClient } from "@i-harness/llm-seam"
import { createUsageStore } from "@i-harness/usage-stats"
import { createUsageCapture } from "./usage-capture.ts"
import {createUsageHandlers} from './usage-host.ts'
import { createUsageObservationSink } from './usage-observation-sink.ts'
import { safeCompactionDiagnostic } from "./context-diagnostics.ts"
import { deriveSessionTitle, rewindCuts, semanticSeedResultRefs } from "@i-harness/core-session"
import { foldGoal } from "@i-harness/goal"
import { createIsolatedReviewerPool, type GuardianIsolatedConfig } from "@i-harness/guard-approval"
import { maybeAutoTitle } from "@i-harness/session-title"
import { createForkSessionController } from "@i-harness/session-persistence"
import { createJsonlTaskTransitionCoordinator } from "@i-harness/session-persistence-jsonl/internal/task-document-factory"
import { taskDocumentStorageContract } from "@i-harness/subagent/internal/task-storage-contract"
import { createFileBackedSessionQuery } from "@i-harness/session-query"
import { openMemoryStore, createMemoryTools } from "@i-harness/memory"
import type { SessionService, SessionProjectContext, SessionAssembly } from "@i-harness/session-executor"
import { createDurableSessionLoader, createSessionService, createInstructionEnvironment, readPendingRewindIntents, type SessionServiceOptions } from "@i-harness/session-executor"
import { acquireChildManagedExecution } from '../../session-executor/src/host-managed-execution.ts'
import { mountChildShellTools } from '../../session-executor/src/child-shell.ts'
import { reportTaskProjectionIssues } from './task-projection-diagnostics.ts'
import { createFsWatchService } from '@i-harness/fs-watch'
import { createSdkServer } from "@i-harness/sdk/server"
import { resolveSettingsPath, SettingsStore, PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"
import { commitModelSwitch } from "./model-switch.ts"
import { createSessionManagement } from "./session-management.ts"
import { createGatewayForkHost } from './fork-session.ts'
import { assertOutsideForkController } from '../../session-persistence/src/fork-controller.ts'
import { createContextPicker } from "./context-picker.ts"
import { createDraftSession } from "./draft-session.ts"
import { createConversationVisibility, createConversationQuery, createSessionRuntimeVisibility } from "./session-visibility.ts"
import { createDesktopSubagents } from "./session-subagents.ts"
import { createInstructionViews } from './instructions/views.ts'
import { createInstructionSettings } from './instructions/settings.ts'
import { createDesktopRewind } from "./rewind.ts"
import { createDesktopPlugins } from "./plugins.ts"
import { pluginExtensions, expandPluginPrompt, mountedHookAuthority } from "./plugin-mount.ts"
import { createDesktopTerminal } from "./terminal.ts"
import { createDesktopSchedules } from "./schedules.ts"
import { createDesktopWorkState } from "./work-state.ts"
import { createAgentSettings } from "./agent-settings.ts"
import { createWslSettings, type WslSettingsOptions } from "./wsl-settings.ts"
import { validateDesktopSettingsDocument } from "./settings-file.ts"
import { createSubagentSettings } from "./subagent-settings.ts"
import { createHookSettings } from "./hook-settings.ts"
import { createDesktopMcp } from "./mcp-settings.ts"
import { createDesktopResources } from "./resources.ts"
import { createEffectiveLocalInputs } from "./effective-local-inputs.ts"
import { createProjectFiles } from "./project-files.ts"
import { createProjectContentSearch } from "./project-content-search.ts"
import { createSessionManagementFence } from "./session-management-fence.ts"
import { createConversationResultReader } from './result-reader.ts'
import { createCodeModeSettings, createDesktopExecution } from "./execution.ts"
import { createExecutionHostObservation } from "./execution-host-observation.ts"
import { createAgentProcesses } from "./agent-processes.ts"
import { createDesktopDiagnostics } from "./environment-diagnostics.ts"
import { createApprovalRulesAdapter, notifyApprovalRuleChanges } from "./approval-rules.ts"
import { createOwnedApprovalBindings } from "./owned-approval-bindings.ts"
import { createOwnedGatewayNative } from './owned-gateway-native.ts'
import { createOwnedGatewayInstructions } from './owned-gateway-instructions.ts'
import { createOwnedGatewayTaskOptions } from './owned-gateway-task.ts'
import { createOwnedGatewayPromptParts } from './owned-gateway-prompt-parts.ts'
import { createOwnedGatewaySelectionOwner } from './owned-gateway-selection-owner.ts'
import { composeOwnedGatewayDefault } from './owned-gateway-default.ts'
import { mountOwnedGatewayGuardian } from './owned-gateway-guardian.ts'
import { mountOwnedGatewayTeam } from './owned-gateway-team.ts'
import { DEFAULT_AGENT_PRESET } from '../../preset/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createOwnedMetadataFold } from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import { summaryFactory } from '../../session-executor/src/context-composition.ts'
import { createCodeTextRetention } from '../../session-executor/src/lifecycle/code-text-retention.ts'
import { renderNativeContextRecovery } from '../../session-executor/src/context-output.ts'
import { registerCodeMode } from '../../code-mode/src/index.ts'
import { resolveWslAgentShell,agentShellPrompt } from '@i-harness/shell'
import { createOwnedIndexJobBindings } from "./owned-index-jobs.ts"
import { onOriginalHostAssembly } from "../../session-executor/src/host-assembly-observer.ts"
import { originalManagedExecutionFor, originalManagedRuntimeFor, prepareOriginalManagedRuntime, retainManagedExecutionCleanup } from '../../session-executor/src/host-managed-execution.ts'
import { enrollFirstPartySelection } from '../../session-executor/src/first-party-selection.ts'
import { createManagedWorkflowUi } from './managed-workflow-ui.ts'
import { approvalPolicyIdentity } from "./approval-policy-identity.ts"
import { createAutoTitleSettings } from "./auto-title.ts"
import { createModelRetrySettings } from "./model-retry-settings.ts"
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
import { createNativeContextRuntime } from "./context-runtime.ts"
import { managedResultRefs } from '@i-harness/core-session'
import { createContextSubsystemSettings } from "./context-subsystems.ts"
import { createCodeRetrievalTools } from "@i-harness/code-retrieval"
import { createCredentialStore } from "@i-harness/credentials"
import { createCodexManagement } from "@i-harness/coding-plans"
import { createCodingPlans } from "./coding-plans.ts"
import { openInteractionPersistence } from "./interaction-persistence.ts"
import { createWorkspaceReview } from "./review.ts"
import type { DesktopHandlers, SandboxState } from "./types.ts"

export interface DesktopHostOptions {
  workspace: string
  sessionDir: string
  settingsPath?: string
  credentialsPath?: string
  wslSettings?: WslSettingsOptions
  workspaceRuntime?: ReturnType<typeof import("@i-harness/workspace-runtime").createWorkspaceRuntime>
  /** Trusted host dependency only; never read from saved settings or RPC data. */
  buildProviderClient?: FileProviderRuntimeOptions["buildClient"]
  /** Fixed for this host lifetime; false explicitly retains legacy recording. */
  experimentalUsageObservations?:boolean
  onWrite: (frame: RpcMessage) => void
}

export interface DesktopHost {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
}

const DESKTOP_GUARDIAN_POLICY = "Review every Agent tool call. Approve only clearly safe, in-scope actions. Return allow when a person should decide because the action is risky or uncertain. Deny clearly malicious or out-of-scope actions. Never execute a tool yourself."

export async function createDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  if (!isAbsolute(options.workspace) || !isAbsolute(options.sessionDir)) {
    throw new Error("workspace and sessionDir must be absolute paths")
  }
  const recordObservations=options.experimentalUsageObservations!==false
  const settingsPath = resolveSettingsPath(options.settingsPath === undefined ? {} : { path: options.settingsPath })
  const settings = new SettingsStore({ path: settingsPath })
  // A fresh missing profile selects this store's native first-run defaults.
  await settings.loadObserved({ validate: validateDesktopSettingsDocument })
  const usageStore = createUsageStore(join(dirname(settingsPath), "usage-stats"))
  const usageObservations=recordObservations?createUsageObservationSink({record:value=>usageStore.recordObservation(value)}):undefined
  const usageCapture = createUsageCapture({ observationMode:!!usageObservations,passiveObserver:usageObservations?.observer,workspace: options.workspace, record: record => usageStore.record(record), projectFor: id => projects.projectFor(id),projectSnapshotFor:id=>projects.projectSnapshotFor(id),
    onRequestFacts: facts => options.onWrite(makeNotification("desktop/context/diagnostic", facts)),
    onWarning: warnings => options.onWrite(makeNotification("desktop/usage/recording-warning", { workspace: options.workspace, warnings })) })
  const usageStats:NonNullable<DesktopHandlers['usageStats']>=createUsageHandlers(usageStore,{recordingMode:usageObservations?'observations':'legacy',warnings:()=>[...usageCapture.warnings(),...(usageObservations?.warnings()??[])]})
  let mode = settings.get().sandboxMode
  let windowsSandboxBackend = settings.get().windowsSandboxBackend
  let wslExecution = { ...settings.get().wslExecution }
  let webSearchMode = settings.get().webSearchMode
  let approvalMode = settings.get().approvalMode
  const codexAccounts = createCodexManagement({ directory: join(dirname(options.credentialsPath ?? join(dirname(settingsPath), "credentials.json")), "coding-plans", "openai-codex") })
  const runtime = createFileProviderRuntime({ settingsPath, credentialsPath: options.credentialsPath ?? join(dirname(settingsPath), "credentials.json"), codex: codexAccounts,
    passiveUsageWorkspace:usageObservations?options.workspace:undefined,
    passiveUsageProjectSnapshotFor:usageObservations?id=>projects.projectSnapshotFor(id):undefined,
    buildClient: usageCapture.buildClient(options.buildProviderClient ?? buildModelClient) })
  const codingPlans = createCodingPlans(codexAccounts, runtime)
  await mkdir(options.sessionDir, { recursive: true })
  const coordinator = createJsonlTaskTransitionCoordinator(options.sessionDir, {
    lock: { enabled: true, lockRoot: options.sessionDir },
    originalExecutionFoldFactory: createOwnedMetadataFold,
  }, taskDocumentStorageContract)
  const compactionSignals = new Map<string, AbortSignal>()
  const isConversation = createConversationVisibility(coordinator)
  const fence = createSessionManagementFence()
  let management: ReturnType<typeof createSessionManagement>
  const drainSession = async (id: string) => { await service.closeSession(id); await approvals.flush() }
  const projects = createProjectScopeBroker(coordinator, options.workspace, createSessionRuntimeVisibility(coordinator), { fence, assertIdle: id => management.assertIdle(id), drainSession,
    authorityChanged: ids => service.reconcileExecutionAuthority(ids) })
  const projectContexts = new Map<string, () => SessionProjectContext | undefined>()
  const executionAuthorities = new Map<string, NonNullable<SessionServiceOptions["executionAuthority"]>>()
  const extensionInputs = new Map<string, RuntimeInputs>()
  const approvals = createDesktopApprovalHistory(coordinator)
  const reviewerPool = createIsolatedReviewerPool()
  const agentShell = createAgentShellSettings(settingsPath)
  let workspaceRuntime: Promise<NonNullable<DesktopHostOptions["workspaceRuntime"]>> | undefined
  const managedRuntime = () => options.workspaceRuntime ? Promise.resolve(options.workspaceRuntime)
    : (workspaceRuntime ??= import("@i-harness/workspace-runtime").then(module => module.createWorkspaceRuntime({ cacheRoot: join(dirname(settingsPath), "workspace-runtime") })))
  const wslSettings = createWslSettings(settingsPath, {
    listDistributions: async () => (await import("@i-harness/sandbox-wsl")).listWslDistributions(),
    inspectRuntime: async distribution => (await import("@i-harness/sandbox-wsl")).inspectWslRuntime(distribution, [options.workspace]),
    diagnoseDependencies: async configuration => (await managedRuntime()).diagnose(configuration),
    repairDependencies: async configuration => (await managedRuntime()).repair(configuration),
    ...options.wslSettings,
  })
  const notifyWorkflow = (sessionId: string) => options.onWrite(makeNotification("desktop/workflow/changed", { sessionId }))
  const modelBindingFor: NonNullable<SessionServiceOptions["modelBindingFor"]> = async (sessionId, meta) => {
    const state = await runtime.resolveModel(meta?.modelSelection === undefined
      ? {}
      : { sessionSelection: meta.modelSelection })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    const mapRequest = (request: LLMRequest): LLMRequest => {
        const compactSignal = compactionSignals.get(sessionId)
        const signal = compactSignal && request.signal
          ? AbortSignal.any([compactSignal, request.signal])
          : compactSignal ?? request.signal
        signal?.throwIfAborted()
        return { ...request, sessionId: request.sessionId ?? sessionId, ...(signal ? { signal } : {}) }
    }
    const model: ModelClient = {
      get executionIdentity() { return client.executionIdentity },
      stream: request => client.stream(mapRequest(request)),
      async prepare(request) {
        const captured = snapshotModelData(request)
        const prepared = await prepareModelRequest(client, mapRequest(captured))
        return withPreparedSignal(prepared, () => compactionSignals.get(sessionId))
      },
    }
    return { status: "ready", binding: { ...binding, model } }
  }
  // The derived in-memory search index belongs to this workspace gateway
  // process. Never call global query cleanup when closing an individual host.
  const sessionQuery = createFileBackedSessionQuery({ storeRoot: options.sessionDir })
  const nativeCredentials=createCredentialStore(options.credentialsPath ?? join(dirname(settingsPath),"credentials.json"))
  const ownedIndexJobs=createOwnedIndexJobBindings()
  const indexJobOwners=new Map<string,WeakRef<SessionAssembly>>()
  const liveIndexJobOwners=()=>{
    const owners:SessionAssembly[]=[]
    for(const [id,reference] of indexJobOwners) {
      const assembly=reference.deref()
      if(!assembly || service.liveAssembly(id)!==assembly)indexJobOwners.delete(id)
      else owners.push(assembly)
    }
    return owners
  }
  const nativeContext=await createNativeContextRuntime({workspace:options.workspace,storageRoot:join(options.sessionDir,"native-context"),coordinator,
    projectFor:projects.nativeScopeFor,
    resultReadScopeFor:projects.resultReadScopeFor,
    withBindingObservation:projects.withBindingObservation,
    retainSelectedProjectRead:projects.retainSelectedBindingRead.bind(projects),
    prepareBootstrapInheritance:projects.prepareBootstrapInheritance,
    prepareTaskChildInheritance:projects.prepareTaskChildInheritance,
    prepareSelectedInheritance:projects.prepareSelectedInheritance.bind(projects),
    references:key=>settings.get().contextSubsystems.workspaceOverrides[key]?.references ?? settings.get().contextSubsystems.references,
    hasVisibleResultRef:async(id,ref)=>{const execution=originalManagedExecutionFor(service,id);if(!execution)return undefined;const observation=execution.observe(),visible=observation.hasVisibleResultRef('version' in ref?{kind:'managed',ref}:{kind:'legacy',id:ref.id});observation.assertCurrent();return visible},
    visibleRefsFor:async id=>{
      const observed=nativeContext.observations.current(id)
      if (observed?.kind === 'managed-task') { observed.assertCurrent(); return observed.artifacts.map(artifact => artifact.ref) }
      const snapshot=observed?.view ?? service.liveSession(id) ?? (await coordinator.snapshot!(id)).session
      observed?.assertCurrent()
      const cuts=rewindCuts(snapshot)
      return [...semanticSeedResultRefs(snapshot), ...snapshot.events.flatMap<ContextResultRef | ManagedArtifactRef>(event=>!cuts.some(cut=>event.seq!==undefined&&event.seq>=cut.cutFrom&&event.seq<cut.markerSeq)?event.type==="context/result-ref"?[event.ref]:managedResultRefs(event):[])]
    },
    resolveCredential:ref=>nativeCredentials.resolve(ref),
    registerJob:(access,job)=>{
      if(access.sessionId===nativeContext.humanSessionId)return undefined
      // Child tools share the owning parent's runtime/registry. Resolve only
      // currently live ownership; registration never constructs an assembly.
      const owner=service.liveAssembly(access.sessionId) ?? liveIndexJobOwners().find(assembly=>assembly.subagentState().agentTable.some(entry=>entry.sessionId===access.sessionId && entry.status==='running'))
      if(owner?.registerBackgroundJob)return owner.registerBackgroundJob({id:job.jobId,kind:'code-context',label:'Index code sources (cancel preserves stored index)',cancel:job.cancel})
      return ownedIndexJobs.register(access.sessionId,{id:job.jobId,kind:'code-context',label:'Index code sources (cancel preserves stored index)',cancel:job.cancel})
    },
  })
  const contextSubsystems=createContextSubsystemSettings({settingsPath,workspaceKey:nativeContext.workspaceKey,workspaceId:nativeContext.workspaceId,
    contextOutput:nativeContext.contextOutput,codeRetrieval:nativeContext.codeRetrieval,
    onReferencesChanged: async references => {
      await projects.configureReferences(references.map(reference => reference.path))
      await nativeContext.configureReferences(references)
    },actionSessionId:nativeContext.humanSessionId})
  await contextSubsystems.sync();nativeContext.syncAutoRefresh()
  const memory = openMemoryStore({ path: join(options.sessionDir, "memory.sqlite"), scope: options.workspace })
  const additionalTools = [...createMemoryTools(memory, () => memory.enabled()), ...createDesktopGoalTools((id) => service.liveSession(id), notifyWorkflow,id=>service.liveAssembly(id)?.metadataFacts),...createCodeRetrievalTools(nativeContext.codeRetrieval)]
  const instructionWatch = createFsWatchService()
  const plugins = createDesktopPlugins(join(dirname(settingsPath), "plugins"), { watch: instructionWatch })
  const terminal = createDesktopTerminal(options.workspace)
  let roleModelsEnabled = settings.get().plugins.subagentModel
  let autoCompactionEnabled = settings.get().compaction.auto
  const subagents = createSubagentSettings(settingsPath, roleModelsEnabled, { onEnabledChanged(next) { roleModelsEnabled = next } })
  const mcpPath = join(dirname(settingsPath), "mcp-servers.json")
  const mcp = createDesktopMcp(mcpPath)
  const autoTitle = createAutoTitleSettings(settingsPath)
  const ownedApprovalBindings = createOwnedApprovalBindings()
  const approvalRulesBase = createApprovalRulesAdapter({ ownedPolicyIdentity: ownedApprovalBindings.identity, filePath: join(options.sessionDir, "approval-rules-v1.json"), policyIdentity: assembly => {
    const project = assembly.sessionId ? projectContexts.get(assembly.sessionId) : undefined
    const inputs = assembly.sessionId ? extensionInputs.get(assembly.sessionId) : undefined
    return project && inputs ? approvalPolicyIdentity(assembly, { workspace: options.workspace, sandbox: mode, approval: approvalMode, project, executionAuthority: executionAuthorities.get(assembly.sessionId!),
      hookConfigs: inputs.hookConfigs, hookAuthority: () => mountedHookAuthority(assembly, inputs.hookConfigs), grantPaths: [resolveHookTrustPath(dirname(settingsPath)), join(dirname(settingsPath), "hook-authoring-grants.json")], pluginAuthority: inputs }) : undefined
  } })
  const approvalRulesChanged = () => { try { options.onWrite(makeNotification("desktop/approval-rules/changed", { workspace: options.workspace })) } catch { /* settings UI refresh is best effort */ } }
  const approvalRules = notifyApprovalRuleChanges(approvalRulesBase, approvalRulesChanged)

  const instructionEnvironment = createInstructionEnvironment({ settingsPath, watch: instructionWatch })
  const isolatedGuardianFor=(sessionId:string):GuardianIsolatedConfig=>({
      pool: reviewerPool,
      permissionContext: () => `${options.workspace}\n${mode}\n${approvalMode}`,
      resolveBinding: async (selection) => {
        const fingerprint = async () => createHash("sha256").update(await readFile(settingsPath, "utf8").catch(() => "")).update(await readFile(options.credentialsPath ?? join(dirname(settingsPath), "credentials.json"), "utf8").catch(() => "")).digest("hex")
        const before = await fingerprint()
        const chosen = selection ?? (await coordinator.profile(sessionId)).meta.modelSelection
        const state = await runtime.resolveModel(chosen ? { sessionSelection: chosen } : {})
        if (state.status !== "ready") throw new Error(state.reason)
        const after = await fingerprint()
        return { client: usageCapture.bind(state.binding.client, sessionId), contextWindow: state.binding.contextWindow, maxOutputTokens: state.binding.maxOutputTokens, budgetBinding: state.binding.budgetBinding,
          reasoningEffort: selection ? state.binding.reasoningEffort : undefined,
          identity: { provider: state.binding.providerId, model: state.binding.modelId, protocol: state.binding.protocol,
            ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}), ...(before === after ? { configurationKey: after } : {}) } }
      },
      onReview: async (record) => { await approvals.append(sessionId, record); notifyWorkflow(sessionId) },
    })
  const ownedAuthorityFor=async(id:string)=>{const project=await projects.forSession(id);projectContexts.set(id,project);const authority=await projects.authorityFor(id);executionAuthorities.set(id,authority);return authority}
  const wslExecutionFor=()=>{const captured={...wslExecution};if(windowsSandboxBackend!=='wsl'||!captured.workspaceDependencies)return captured;return managedRuntime().then(async runtime=>{const resolved=await runtime.resolve(captured,{installIfMissing:true});if(resolved.status==='missing'||resolved.status==='unavailable')throw Error(resolved.detail);return {...captured,...resolved.runtimePath?{runtimePath:[...resolved.runtimePath]}:{}}})}
  const ownedNative=createOwnedGatewayNative({authorityFor:ownedAuthorityFor,mode:()=>mode,executionOptions:async()=>({windowsSandboxBackend,wslExecution:await wslExecutionFor()}),async resolveShell(_id,config){if(config.windowsSandboxBackend!=='wsl')return agentShell.resolve;const wsl=config.wslExecution;if(!wsl)throw Error('Original WSL execution configuration unavailable');const inspected=await (await import('@i-harness/sandbox-wsl')).inspectWslRuntime(wsl.distribution,[options.workspace]);const shell=resolveWslAgentShell(wsl,inspected.paths.find(path=>path.windows===options.workspace)?.linux);return ()=>shell},resultOptions:id=>({workspace:options.workspace,coordinator,sessionId:id,contextOutput:nativeContext.contextOutput,contextOutputSourceFor:nativeContext.sourceFor,contextOutputLegacyReadObservation:nativeContext.withLegacyReadObservation,projectContext:()=>projectContexts.get(id)?.()})})
  const ownedInstructions=createOwnedGatewayInstructions({workspace:options.workspace,environment:instructionEnvironment,authorityFor:ownedAuthorityFor})
  const ownedSelection=createOwnedGatewaySelectionOwner({plugins,mcp,workspace:options.workspace,configDir:dirname(settingsPath)})
  const ownedBindings=new Map<string,()=>import('../../session-executor/src/managed-assembly.ts').ManagedExecutionModelBinding>(),ownedHookContexts=new Map<string,()=>string>(),ownedTaskInputs=new Map<string,Awaited<ReturnType<NonNullable<NonNullable<SessionServiceOptions['managedRuntime']>['ownedTask']>['options']>>>()
  const ownedChildHosts=new Map<string,ReturnType<typeof import('../../session-executor/src/context/instructions/child-host.ts').createChildInstructionHost>>()
  const ownedTaskOptions:NonNullable<NonNullable<SessionServiceOptions['managedRuntime']>['ownedTask']>['options']=async(original,live)=>{
    const id=original.domain.sessionId,binding=()=>{const read=ownedBindings.get(id);if(!read)throw Error('Original model binding unavailable');return read()},hook=()=>{const read=ownedHookContexts.get(id);if(!read)throw Error('Original hook context unavailable');return read()}
    if(!original.instructions)throw Error('Original instruction binding unavailable')
    const parts=createOwnedGatewayPromptParts(original,{workspace:options.workspace,rewindEnabled:true,mode:()=>mode,authority:original.instructions.authority,project:()=>projectContexts.get(id)?.(),shell:()=>ownedNative.agentShellFor(id)})
    const result=await createOwnedGatewayTaskOptions({bindChildHost(childId,host){if(childId!==id||ownedChildHosts.has(id))throw Error('Original child instruction host already bound');original.retain(()=>{if(ownedChildHosts.get(id)===host)ownedChildHosts.delete(id)});ownedChildHosts.set(id,host)},coordinator,prepareTaskChild:nativeContext.prepareTaskChild,resolveModel:selection=>runtime.resolveModel({sessionSelection:selection}),roleSelectionFor:subagents.selectionFor,allowSubagentModelSelection:()=>roleModelsEnabled,autoCompactionEnabled:()=>autoCompactionEnabled,
      childShellFactory:async({ctx,tools,sessionId})=>{
        if(!sessionId)return
        let acquired:Awaited<ReturnType<typeof acquireChildManagedExecution>>
        try{acquired=await acquireChildManagedExecution(service,sessionId)}catch{return}
        const retained:(()=>void|Promise<void>)[]=[]
        try{
          const host=await ownedNative.acquireExecution(sessionId,cleanup=>retained.push(cleanup),acquired.execution)
          const output=await ownedNative.acquireOutput(sessionId,cleanup=>retained.push(cleanup))
          mountChildShellTools({ctx,tools,workspace:options.workspace,execution:acquired.execution,host,output:output.service,release:async()=>{for(const cleanup of retained.reverse())await cleanup();await acquired.release()}})
        }catch{
          // Best effort: without a child execution host the child keeps the
          // previous (unavailable) behavior; a spawn must not fail because of it.
          for(const cleanup of retained.reverse())await Promise.resolve(cleanup()).catch(()=>{})
          await acquired.release().catch(()=>{})
        }
      },
      childOptions:{generationFactoryFor:(owner,sessionId,selected)=>(action,deps)=>createGenerationLifecycle(owner.view,sessionId,action,{enabled:false,selectedClient:selected},usageObservations?{...deps,beforeDrain:deps?.beforeDrain??(async()=>{}),passiveGeneration:usageObservations.observer}:deps),summaryFactory,
       inheritedBindingForStep:()=>{const value=binding();return {identity:value.model,executionIdentity:value.model.executionIdentity,contextMetadata:value.contextMetadata,budgetBinding:value.budgetBinding,contextWindow:value.contextWindow,maxOutputTokens:value.maxOutputTokens,reasoningEffort:value.reasoningEffort}},
       get contextWindow(){return binding().contextWindow},get budgetBinding(){return binding().budgetBinding},get contextMetadata(){return binding().contextMetadata},get reasoningEffort(){return binding().reasoningEffort},get maxOutputTokens(){return binding().maxOutputTokens},
       inheritedSystemContext:child=>[parts.project(),hook(),...(ownedNative.agentShellFor(id).executionTarget==='wsl'?[agentShellPrompt(ownedNative.agentShellFor(id))]:[]),child?renderNativeContextRecovery(nativeContext.contextOutput,child):''].filter(Boolean).join('\n\n'),
       codeModeFactory:(ctx,tools,mountOptions)=>registerCodeMode(ctx,tools,{retainText:createCodeTextRetention({service:nativeContext.contextOutput,sessionId:mountOptions.sessionId,sourceFor:nativeContext.sourceFor}),...mountOptions,config:codeSettings.resolve()})}})(original,live)
    original.assertCurrent();original.retain(()=>{if(ownedTaskInputs.get(id)===result)ownedTaskInputs.delete(id)});ownedTaskInputs.set(id,result);return result
  }
  const serviceOptions: SessionServiceOptions = {
    passiveGeneration:usageObservations?.observer,
    prepareTaskChild:nativeContext.prepareTaskChild,
    instructionEnvironment,
    telemetry: { close() {}, emit(event) {
      if (event.type !== "compaction/attempt" && !(event.type === "provider/context" && event.data.operation === "summary")) return
      const compaction = safeCompactionDiagnostic({ ...event.data, operation: event.type === "compaction/attempt" ? "attempt" : "summary" })
      if (compaction) { try { options.onWrite(makeNotification("desktop/context/diagnostic", { sessionId: event.data.sessionId, compaction })) } catch { /* Observer isolation. */ } }
    } },
    videoAudioAnalyzer: input => runtime.analyzeVideoAudio?.(input) ?? Promise.resolve({ status: "unconfigured", reason: "Video audio analysis is unavailable in this provider runtime." }),
    sessionOperation: fence,
    projectContextFor: async id => { const getter = await projects.forSession(id); projectContexts.set(id, getter); return getter },
    executionAuthorityFor: async id => { const get = await projects.authorityFor(id); executionAuthorities.set(id, get); return get },
    windowsSandboxBackendFor: () => windowsSandboxBackend,
    wslExecutionFor,
    webSearchModeFor: () => webSearchMode,
    webCacheRoot: join(options.sessionDir, "web-cache"),
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
    extensionsFor: async (id) => { const inputs = await createEffectiveLocalInputs(options.workspace, dirname(settingsPath), await plugins.inputs()); extensionInputs.set(id, inputs); return pluginExtensions(inputs, dirname(settingsPath), id, (messages) => plugins.report(id, messages), await mcp.active(), options.workspace, () => approvalMode) },
    transformPrompt: expandPluginPrompt,
    rewindStoreRoot: options.sessionDir,
    additionalTools,
    contextOutput:nativeContext.contextOutput,
    contextOutputSourceFor:nativeContext.sourceFor,
    contextOutputLegacyReadObservation:nativeContext.withLegacyReadObservation,
    resultReadScopeFor:projects.resultReadScopeFor,
    sessionQuery,
    workspace: options.workspace,
    sandbox: mode,
    allowRuntimeSandboxChanges: true,
    approvalMode: () => approvalMode,
    guardian: { policy: DESKTOP_GUARDIAN_POLICY, enabled: () => approvalMode === "delegate", fallbackToHumanOnFailure: true, allowModelSelection: true, execution: "isolated", isolated: isolatedGuardianFor },
    modelPolicy: "required",
    modelBindingFor,
    modelMetadataFor: (_sessionId, meta) => runtime.describeModelBindingMetadata?.(meta?.modelSelection ? { sessionSelection: meta.modelSelection } : {}),
    afterSuccessfulSubmit: async (sessionId, assembly, limits, action) => {
      if (!autoTitle.enabled()) return
      const { meta } = await coordinator.profile(sessionId)
      action.assertOpen()
      if (meta.title?.trim()) return
      await maybeAutoTitle({
        session: assembly.session,
        action,
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
    compact: { auto: settings.get().compaction.auto },
    managedRuntime: {
      systemPrompt: DEFAULT_AGENT_PRESET.systemPrompt, tools: [], originalFilesystem: true, requireFilesystemPolicy: true,
      originalSchedule: true, originalApproval: true, approvalMode: () => approvalMode,
      compact: { auto: settings.get().compaction.auto }, autoCompactionEnabled: () => autoCompactionEnabled,
      acquireInstructions: ownedInstructions, ownedShell: { ...ownedNative, agentShell: agentShell.resolve },
      ownedCode: { configFor: () => codeSettings.resolve(), acquireOutput: ownedNative.acquireOutput },
      ownedTask: { options: ownedTaskOptions }, ownedWorkflow: true,
      ownedRewind: { root: options.sessionDir, workspace: options.workspace },
      ownedTitle: { get enabled() { return autoTitle.enabled() }, titleMaxOutputTokens: 2048, timeoutMs: 8000 },
      onTeamRecoveryRequired: sessionId => options.onWrite(makeNotification('session/status', { sessionId, status: 'error', code: 'TEAM_RECOVERY_REQUIRED' })),
      async mountDefaultSurface(original, live) {
        const id=original.domain.sessionId
        if(!live.task||!live.output||!live.shell||!live.parentNotify||!original.instructions)throw Error('Original Gateway owners unavailable')
        const task=live.task,output=live.output,shell=live.shell,parentNotify=live.parentNotify,instructions=original.instructions
        if(ownedBindings.has(id))throw Error('Original model binding already installed')
        original.retain(()=>{if(ownedBindings.get(id)===live.modelBinding)ownedBindings.delete(id)})
        ownedBindings.set(id,live.modelBinding)
        const parts=createOwnedGatewayPromptParts(original,{workspace:options.workspace,rewindEnabled:true,mode:()=>mode,authority:instructions.authority,project:()=>projectContexts.get(id)?.(),shell:()=>ownedNative.agentShellFor(id)})
        const taskOptions=ownedTaskInputs.get(id);if(!taskOptions)throw Error('Original Task options unavailable')
        await mountOwnedGatewayGuardian(original,task,{get parentModel(){return live.modelBinding().model},get contextWindow(){return live.modelBinding().contextWindow},get budgetBinding(){return live.modelBinding().budgetBinding},get contextMetadata(){return live.modelBinding().contextMetadata},get reasoningEffort(){return live.modelBinding().reasoningEffort},get maxOutputTokens(){return live.modelBinding().maxOutputTokens},inheritedBindingForStep:taskOptions.inheritedBindingForStep,summaryFactory,resolveModel:selection=>runtime.resolveModel({sessionSelection:selection}),roleSelectionFor:subagents.selectionFor,allowSubagentModelSelection:()=>true,autoCompactionEnabled:()=>autoCompactionEnabled,policyText:DESKTOP_GUARDIAN_POLICY,enabled:()=>approvalMode==='delegate',fallbackToHumanOnFailure:true,isolated:isolatedGuardianFor(id),breaker:{coordinator,sessionId:id},childSessions:{coordinator,parentSessionId:id}})
        return composeOwnedGatewayDefault(original,{
          task,indexJobs:ownedIndexJobs,selection:ownedSelection,bindings:ownedApprovalBindings,output:output.service,subagentStaleAfterMs:600000,
          bindHookContext(read){if(ownedHookContexts.has(id))throw Error('Original hook context already installed');original.retain(()=>{if(ownedHookContexts.get(id)===read)ownedHookContexts.delete(id)});ownedHookContexts.set(id,read)},
          leaves:{workspace:options.workspace,webCacheRoot:join(options.sessionDir,'web-cache'),webSearchMode:()=>webSearchMode,sessionQuery,videoAudioAnalyzer:input=>runtime.analyzeVideoAudio?.(input)??Promise.resolve({status:'unconfigured',reason:'Video audio analysis is unavailable in this provider runtime.'}),additionalTools:[...createMemoryTools(memory,()=>memory.enabled()),...createCodeRetrievalTools(nativeContext.codeRetrieval)]},
          extensions:{roles:task.roles,workspace:options.workspace,configDir:dirname(settingsPath),startSource:(()=>{const observed=original.execution.observe(),source=observed.hasConversationMessages?'resume':'startup';observed.assertCurrent();return source})(),report:messages=>plugins.report(id,messages),interaction,policy:()=>({workspace:options.workspace,sandbox:mode,approval:approvalMode,project:()=>projectContexts.get(id)?.(),executionAuthority:executionAuthorities.get(id),hookConfigs:[],grantPaths:[resolveHookTrustPath(dirname(settingsPath)),join(dirname(settingsPath),'hook-authoring-grants.json')],pluginAuthority:{}})},
          surface:{policyPrompt:parts.policy,shellPrompt:parts.shell,projectPrompt:parts.project,schemas:live.modelToolSchemas,goalChanged:()=>notifyWorkflow(id),async reconcileAuthority(){instructions.manager.diagnostics.invalidate();ownedChildHosts.get(id)?.invalidateDiagnostics();await ownedNative.reconcile(id)},async activateAfterTaskReady(){const taskOptions=ownedTaskInputs.get(id);if(!taskOptions)throw Error('Original Task options unavailable');await mountOwnedGatewayTeam(original,{task,taskOptions,shell,coordinator,parentNotify,modelBinding:live.modelBinding,retainTeamRecovery:live.retainTeamRecovery})}},
        })
      },
    },
  }
  enrollFirstPartySelection(Object.freeze({options:serviceOptions,prepare:ownedSelection.prepare,refresh:ownedSelection.refresh,release:ownedSelection.release}))
  const service: SessionService = createSessionService(serviceOptions)
  const codeSettings = createCodeModeSettings(settingsPath, service)
  const rawInput = createDesktopInput(coordinator, service, {
    managedPreparation: true,
    prepare: async (id, text) => expandPluginPrompt(await service.assemblyFor(id), text),
    onStatus: (sessionId, running, error, modelFailure) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "error" : "completed", ...(error ? { error } : {}), ...(modelFailure ? { modelFailure } : {}) })),
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
  const agentSettings = createAgentSettings(settingsPath, { sandboxMode: mode, windowsSandboxBackend, wslExecution, webSearchMode, autoCompaction: settings.get().compaction.auto, approvalMode }, {
    onWindowsSandboxBackendChanged(next) { windowsSandboxBackend = next },
    onWslExecutionChanged(next) { wslExecution = { ...next } },
    onWebSearchModeChanged(next) { webSearchMode = next },
    executionStatus: () => service.executionBackendStatus(),
    async onSandboxModeChanged(next) { mode = next; await service.updateSandboxMode(next) },
    onApprovalModeChanged(next) { approvalMode = next },
    onAutoCompactionChanged(next) { autoCompactionEnabled = next },
  })
  // Reloading a session retires its live interaction cards first: the tool call
  // they belong to no longer exists after the session is closed, so leaving a
  // card approving/remembering it would grant a rule for a vanished operation.
  const reloadSession = async (sessionId: string) => {
    interaction.cancelSession(sessionId)
    await drainSession(sessionId)
    // D-01: a reload is the natural point to CHECK the task projection against
    // durable child sessions. Read-only: reconcile remains an explicit request.
    const issues = await reportTaskProjectionIssues(service, sessionId)
    // S-07: a pending rewind intent means files may have been restored without
    // the marker; surface it through the same reload diagnostic notification.
    const pendingRewinds = await readPendingRewindIntents(coordinator.storageRoot, sessionId).catch(() => [])
    const kinds = [...issues.map(issue => issue.kind), ...pendingRewinds.map(() => "rewind-intent-pending" as const)].slice(0, 32)
    if (kinds.length > 0) {
      try {
        options.onWrite(makeNotification("desktop/tasks/projection", { sessionId, issues: kinds }))
      } catch { /* diagnostics must not break a reload */ }
    }
  }
  const stopPluginObserver = plugins.bindRefresh(() => service.refreshExtensions())
  mcp.bindRefresh(() => plugins.refresh())
  const offInteraction = onOriginalHostAssembly(service,(assembly) => { interaction.attach(assembly);liveIndexJobOwners();if(assembly.sessionId)indexJobOwners.set(assembly.sessionId,new WeakRef(assembly)) })
  const sessionSubagents = createDesktopSubagents(coordinator, service, {
    async readResult(access, ref, args) {
      const sameScope = async () => { if ((await nativeContext.sourceFor(access.sessionId)).sourceId !== (await nativeContext.sourceFor(access.ownerSessionId)).sourceId) throw new Error("Child result source is outside the current parent scope") }
      await sameScope()
      const page = await nativeContext.contextOutput.readResult({ sessionId: access.ownerSessionId }, { ref, ...args })
      await sameScope()
      return page
    },
    onChanged: sessionId => options.onWrite(makeNotification("desktop/session/subagents/changed", { sessionId })) })
  const instructions = createInstructionViews(coordinator, service, async input => {
    const { meta } = await coordinator.profile(input.sessionId)
    if (!await isConversation(input.sessionId, meta)) throw new Error('Conversation unavailable')
    const parent = await projects.nativeScopeFor(input.sessionId)
    if (!input.childSessionId) return JSON.stringify(parent)
    const child = await projects.nativeScopeFor(input.childSessionId)
    if (child.projectId !== parent.projectId) throw new Error('Child is outside the parent project')
    return JSON.stringify([parent, child])
  }, event => options.onWrite(makeNotification('desktop/instructions/changed', event)))
  const review = createWorkspaceReview(options.workspace)
  const projectContentSearch = createProjectContentSearch(options.workspace)
  const managedWorkflowUis=new Map<string,{execution:import('../../session-persistence/src/execution-internal.ts').ManagedExecutionAttachment;ui:ReturnType<typeof createManagedWorkflowUi>}>()
  const workflowUiFor=(id:string)=>{const runtime=originalManagedRuntimeFor(service,id);if(!runtime)return undefined;const existing=managedWorkflowUis.get(id);if(existing?.execution===runtime.execution){runtime.assertCurrent();return existing.ui}if(existing)throw Error('Original managed workflow owner changed');const retain=(close:()=>Promise<void>)=>retainManagedExecutionCleanup(service,id,runtime.execution,close);const ui=createManagedWorkflowUi({id,...runtime,retain,coordinator,service,teamEnabled:true,async jobEvents(documentJobIds){runtime.assertCurrent();const observation=runtime.execution.observe(),events=await observation.jobStatusEvents(documentJobIds);observation.assertCurrent();runtime.assertCurrent();return events},async lastStepSince(ordinal){runtime.assertCurrent();const observation=runtime.execution.observe(),end=await observation.lastStepEndSince(ordinal);observation.assertCurrent();runtime.assertCurrent();return end}});retain(async()=>{if(managedWorkflowUis.get(id)?.ui===ui)managedWorkflowUis.delete(id)});managedWorkflowUis.set(id,{execution:runtime.execution,ui});return ui}
  const rawWorkflow = createDesktopWorkflow(coordinator, service, { teamEnabled: true, reviews: approvals.read, onChanged: notifyWorkflow,managed:workflowUiFor,async managedForMutation(id){const runtime=await prepareOriginalManagedRuntime(service,id);return runtime?workflowUiFor(id):undefined},
    onRunningChanged: (sessionId, running, error) => options.onWrite(makeNotification("session/status", { sessionId, status: running ? "queued" : error ? "error" : "completed", ...(error ? { error } : {}) })) })
  const workflow = { ...rawWorkflow, mutate: (id: string, command: unknown) => fence.run(id, () => rawWorkflow.mutate(id, command)) }
  management = createSessionManagement(coordinator, service, isConversation, { workspace: options.workspace, sessionDir: options.sessionDir, fence,
    projectFor: projects.projectFor, onVisibilityWithdrawn: id => instructions.revokeSession(id), moveProject: projects.move, pendingInteractions: async id => interaction.pending(id),
    activeWork: async id => (await workflow.read(id)).goalRun?.running === true, drainSession })
  const schedules = createDesktopSchedules(coordinator, service)
  const rewind = createDesktopRewind(options.sessionDir, options.workspace, coordinator, service)
  const workState = createDesktopWorkState(coordinator, service, { managed:{current:id=>originalManagedExecutionFor(service,id),retain:(id,execution,close)=>retainManagedExecutionCleanup(service,id,execution,close)},sessionFor: async (id) => {
    const state = await service.modelState(id)
    return state.status === "ready" ? (await service.assemblyFor(id)).session : await createDurableSessionLoader(coordinator)(id)
  } })
  const execution = createDesktopExecution(coordinator, service)
  const executionObservation = createExecutionHostObservation(coordinator, projects, service, execution)
  const conversationRead = createConversationResultReader(coordinator, service, isConversation, fence)
  const agentProcesses = createAgentProcesses(coordinator, service, { runRead: createAgentProcessReadRunner({ coordinator, service, isConversation, fence, resultReadScopeFor: projects.resultReadScopeFor, readResultPage: conversationRead }) })
  const resources = createDesktopResources(options.workspace, () => plugins.inputs(), { configDir: dirname(settingsPath), refresh: () => service.refreshExtensions() })
  const handlers: DesktopHandlers = {
    workspace: options.workspace, autoTitle, modelRetry: createModelRetrySettings(settingsPath), modelWait: createModelWaitSettings(settingsPath), codeSettings, approvalRules, usageStats,
    assertSession: async id => { const { meta } = await coordinator.profile(id); if (!await isConversation(id, meta)) throw new Error("Conversation unavailable") },
    executionObservation,
    execution: { ...execution, stop: (id, cellId) => fence.run(id, () => execution.stop(id, cellId)) },
    agentProcesses: { ...agentProcesses, control: (id, command) => fence.run(id, () => agentProcesses.control(id, command)) },
    diagnostics: createDesktopDiagnostics(service, { shell: agentShell }),
    taskProjection: async (id, options) => {
      if (!service.taskProjectionIntegrity) throw new Error("Task projection unavailable")
      return service.taskProjectionIntegrity(id, options)
    },
    draftSession: createDraftSession(coordinator),
    sessionReload: reloadSession,
    contextPicker: createContextPicker(options.workspace, coordinator, review, { visible: isConversation, projectFor: projects.projectFor, query: createConversationQuery(coordinator, sessionQuery) }),
    workflow, agentShell, wslSettings, input, projects: { ...projects, bind: (id, projectId) => fence.run(id, () => projects.bind(id, projectId)) },
    resources,
    projectFiles: createProjectFiles(options.workspace, review),
    projectContentSearch,
    mcp,
    hooks: createHookSettings(dirname(settingsPath), async () => (await createEffectiveLocalInputs(options.workspace, dirname(settingsPath), await plugins.inputs())).hookConfigs, () => service.refreshExtensions(), { workspace: options.workspace }),
    subagents, sessionSubagents, instructions, instructionSettings: createInstructionSettings(settingsPath),
    agentSettings,
    contextSubsystems,
    terminal,
    schedules: { ...schedules, create: (id, command) => fence.run(id, () => schedules.create(id, command)), delete: (id, scheduleId) => fence.run(id, () => schedules.delete(id, scheduleId)) },
    workState: { ...workState, writeTodos: (id, command) => fence.run(id, () => workState.writeTodos(id, command)) },
    plugins: { ...plugins, commands: async () => (await resources.effectiveInputs()).commandDescriptors.map(({ name, description, argumentHints }) => ({ name, description, argumentHints })) },
    rewind: { ...rewind, execute: (id, target, mode, fingerprint) => fence.run(id, () => rewind.execute(id, target, mode, fingerprint)) },
    sessions: { ...management, batch: async command => { const result = await management.batch(command); if (command.action === "delete") for (const row of result.results) if (row.ok) approvalRules.removeSession(row.sessionId); return result },
      mutate: async (id, action, title) => { const result = await management.mutate(id, action, title); if (action === "delete") approvalRules.removeSession(id); return result } },
    provider: runtime,
    codingPlans,
    memory,
    compact: (sessionId, instructions, signal) => fence.run(sessionId, async () => {
      signal.throwIfAborted()
      const state = service.queueState(sessionId)
      if (state.running || state.queued > 0) throw new Error("session is busy")
      compactionSignals.set(sessionId, signal)
      try {
        const result = await service.compact(sessionId, instructions, signal)
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
  const forkController=createForkSessionController(coordinator,createGatewayForkHost({workspace:options.workspace,coordinator,projects,nativeContext,
    assertAvailable(){if(shutdownRequested)throw new Error('Desktop host is closing')}}))
  const base = createSdkServer(service, {
    readResultPage: conversationRead,
    supportsResultDependencyMembership: true,
    coordinator,
    prepareForkSession:request=>forkController.prepare(request),
    executeForkSession:(command,control)=>forkController.execute(command,control),
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
          const execution=originalManagedExecutionFor(service,id)
          const turnCount=execution?(()=>{const observation=execution.observe(),count=observation.turnCount;observation.assertCurrent();return count})():(service.liveSession(id) ?? (await (coordinator.snapshot?.(id) ?? coordinator.load(id))).session).events.filter((event) => event.type === "turn/end").length
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
  let shutdownRequested = false
  let shutdownComplete = false
  const cleaned = new Set<string>()
  const trustWatcher = watchSettings([resolveHookTrustPath(dirname(settingsPath)), mcpPath], async () => {
    if (!shutdownRequested) await mcp.refresh().catch(() => { /* Settings surfaces expose live refresh failures. */ })
  }, { service: instructionWatch })
  let policySync: Promise<void> | undefined
  const syncPolicy = () => {
    if (shutdownRequested || policySync) return
    // Both reads own settings file leases. An early failure must not release
    // shutdown's ownership of the other read while it can still create a lock.
    const job = Promise.allSettled([agentSettings.sync(), subagents.state(),contextSubsystems.sync().then(()=>nativeContext.syncAutoRefresh())]).then((results) => {
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
    handleLine: (line) => shutdownRequested ? Promise.reject(new Error("Desktop host is closing")) : router.handleLine(line),
    close: () => {
      assertOutsideForkController(coordinator)
      executionObservation.fence()
      if (shutdownComplete) return Promise.resolve()
      if (closing) return closing
      const cleanupOperation = createRetainedCleanupOperation()
      shutdownRequested = true
      let pluginFenceFailure: { cause: unknown } | undefined
      try { stopPluginObserver.dispose() } catch (cause) { pluginFenceFailure = { cause } }
      instructionEnvironment.dispose()
      const attempt = (async () => {
        const failures: Array<{ name: string; cause: unknown }> = []
        const once = async (name: string, dispose: () => void | Promise<void>) => {
          if (cleaned.has(name)) return
          try { await dispose(); cleaned.add(name) }
          catch (cause) { failures.push({ name, cause }) }
        }
        if (pluginFenceFailure) failures.push({ name: "plugin observer fence", cause: pluginFenceFailure.cause })
        await once("trust watcher fence", () => trustWatcher.dispose())
        await once("policy timer", () => clearInterval(policyTimer))
        await once("interaction", () => interaction.close())

        await once("terminal", () => terminal.close())
        await once("interaction subscription", () => offInteraction())
        await once("input", () => input.close())
        await once("project content search", () => projectContentSearch.close())
        await once("work state", () => workState.close())
        await once("router", () => router.close())
        await once("execution observation", () => executionObservation.close(cleanupOperation))
        await once('fork controller',()=>forkController.close())
        await once("coding plans", () => codingPlans.close())
        await once("WSL settings", () => wslSettings.close())
        await once("session subagents", () => sessionSubagents.close())
        await once('instruction subscriptions', () => instructions.close())
        const forksJoined=cleaned.has('router')&&cleaned.has('fork controller')&&cleaned.has('execution observation')
        if(forksJoined)await once("projects", () => projects.close())
        await once("review", () => review.close())
        if(forksJoined)await once("workflow", () => workflow.close())
        if(forksJoined)await once("session service", () => service.close())
        if(forksJoined&&cleaned.has('session service'))await once('usage observations',async()=>{await usageObservations?.close()})
        if(forksJoined)await once("native context", () => nativeContext.close())
        await once("approvals", () => approvals.flush())
        await once("plugin observer", () => stopPluginObserver.close())
        await once("plugins", () => plugins.close())
        // A refresh may await creating session assemblies. Fence early, but
        // join only after their owners can settle shutdown dependencies.
        await once("trust watcher", () => trustWatcher.close())
        if (cleaned.has('session service')) await once('instructions', () => instructionEnvironment.close())
        if (cleaned.has('trust watcher') && cleaned.has('instructions') && cleaned.has('plugins') && cleaned.has('plugin observer')) await once('instruction watch', () => instructionWatch.close())
        await once("policy refresh", async () => { await policySync })
        await once("memory", () => memory.close())
        if (forksJoined&&cleaned.has("session service")&&cleaned.has('native context')) await once("coordinator", () => closeCoordinatorWithRetainedCleanupOperation(coordinator, cleanupOperation))
        if (failures.length) throw new AggregateError(failures.map(item => item.cause),
          `Desktop host cleanup incomplete: ${failures.map(item => item.name).join(", ")}`)
        shutdownComplete = true
      })().finally(() => finishRetainedCleanupOperation(cleanupOperation))
      closing = attempt
      void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
      return attempt
    },
  }
}
