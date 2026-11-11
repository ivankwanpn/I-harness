import type { ReasoningEffort } from "@i-harness/core-agent"
import { forkTurns } from "./fork.ts"
import { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
import type { SpawnOptions } from "./child/types.ts"
import { assembleChild } from "./child/assembly.ts"
import { publishChild, warnInheritedSeed } from "./child/lifecycle.ts"
import { openChildDocument } from './child/document.ts'
import { openInitialChildGeneration, type InitialChildInput } from './child/generation.ts'
import { captureChildInstructionContext } from './child/instruction-context.ts'
import { invokeOriginal } from './followup/resident-lifetime.ts'
import {claimTaskChildBirth,markTaskChildAdopted} from './child/task-birth.ts'
import {captureHostChildInput,captureHostModelSelection,openHostChildBirth,type HostChildBirth} from './child/host-birth.ts'

export { SUBAGENT_PROMPT_CONTRACT, composeSubagentPrompt, estimateChildOverhead } from "./child/prompt.ts"
export { resolveRoleTools } from "./child/role-tools.ts"
export { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
export type { RoleModelHost, RoleModelSelection, RoleModelState } from "./child/model-binding.ts"
export type { SpawnOptions } from "./child/types.ts"

function dataMethod<T extends (...args: any[]) => any>(owner: object, name: string): T | undefined {
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) { if ('value' in descriptor && descriptor.value === undefined) return undefined; if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value as T; break }
  }
  if (name in owner) throw new TypeError(`Invalid child ${name} capability`)
  return undefined
}

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string; modelLabel?: string }> {
  const childOrigin:unknown=opts.childSessions?.origin
  if(childOrigin==='team')throw Object.assign(new Error('Team execution has been removed'),{code:'TEAM_EXECUTION_REMOVED'})
  const originalFactory = dataMethod<NonNullable<SpawnOptions['createInstructionContext']>>(opts, 'createInstructionContext')
  const createInstruction = originalFactory?.bind(opts)
  const failedSettlement = originalFactory && dataMethod<NonNullable<import('./child/instruction-context.ts').ChildInstructionContextFactory['settleFailed']>>(originalFactory, 'settleFailed')?.bind(originalFactory)
  const retainInitial = dataMethod<NonNullable<SpawnOptions['retainInitialSetup']>>(opts, 'retainInitialSetup')?.bind(opts)
  // Pure role gates precede any child document or executable model resolution.
  const committed=opts.childStart?.kind==='committed-child-birth'?claimTaskChildBirth(opts.childStart.birth):undefined
  const captured = !committed && opts.childSessions ? captureHostChildInput(opts) : undefined
  const role = captured ? captured.data.role : opts.role
  const selected = committed ? committed.declared : declaredRoleModel(role, opts)
  const declared = captured && selected !== undefined ? captureHostModelSelection(selected) : selected
  if (subagentModelSelectionGated(opts, declared)) throw subagentModelSelectionDisabled(opts.role.name)
  if (opts.childSessions && !opts.childSessions.coordinator.openManagedDocument) throw Object.assign(new Error('Durable child requires the owned fact capability'), { code: 'FACT_OWNER_UNSUPPORTED' })

  const childPath = captured
    ? `${captured.data.parentPath}/${captured.data.taskName}`
    : `${opts.parentPath}/${opts.taskName}`
  const parentContext = opts.parentCtx
  const signal = captured ? captured.signal : opts.signal
  const resolveModel = opts.resolveModel
  const inheritedBindingForStep = opts.inheritedBindingForStep
  let childCtx!: ReturnType<typeof opts.parentCtx.scope.mount>
  let unmountContext: (() => void) | undefined
  let contextCreated = false
  let contextFailure: { cause: unknown } | undefined
  let hostBirth: HostChildBirth | undefined

  // Only the nondurable branch uses raw seed records. Durable construction
  // captures a semantic observation and commits it through atomic bootstrap.
  const turns = opts.forkTurns ?? "none"
  if (!committed && !opts.parentSession) throw new TypeError('Original parent session or committed child birth required')
  const seedEvents = committed || captured || turns === "none" ? [] : forkTurns(opts.parentSession!.events, turns === "all" ? Infinity : turns, opts.parentSession!.formatVersion, opts.parentSession!.header)
  let sessionId: string | undefined
  const childDepth = committed ? committed.request.core.lineage.delegationDepth
    : captured ? captured.data.delegationDepth : (opts.parentSession!.header?.delegationDepth ?? 0) + 1
  const start = committed?.start??{ wall: Date.now(), monotonic: performance.now() }
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)

  let results = opts.results
  let model = opts.parentModel
  let reasoningEffort: ReasoningEffort | undefined = opts.reasoningEffort
  let budgetBinding = opts.budgetBinding
  let contextMetadata = opts.contextMetadata
  let contextWindow = opts.contextWindow
  let maxOutputTokens = opts.maxOutputTokens
  let modelLabel: string | undefined
  let initial: InitialChildInput | undefined
  let document: import('@i-harness/session-persistence').ManagedDocument | undefined
  let closeDocument: (() => Promise<void>) | undefined, revokeDocument: (() => void) | undefined, closeInitial: (() => Promise<void>) | undefined
  let cancelRuntime: ((reason?: string) => Promise<void>) | undefined, disposeRuntime: (() => Promise<void>) | undefined
  let instruction: import('./child/instruction-context.ts').ChildInstructionContext | undefined
  let instructionCleanup: Pick<import('./child/instruction-context.ts').ChildInstructionContext, 'retire' | 'close'> | undefined
  let failedInstructionInput: import('./child/instruction-context.ts').ChildInstructionContextInput | undefined, failedInstructionSettled = false
  let instructionAvailable = true
  let transferred = false, publishedEntry: import('./agent-table.ts').ChildAgentEntry | undefined, releaseSetup: (() => void) | undefined
  let setupClosed = false, mountCancelled = false, mountDisposed = false, initialClosed = false, instructionClosed = false, documentClosed = false, contextClosed = false
  let retirementFault: { error: unknown } | undefined
  let setupFlight: Promise<void> | undefined
  const setupExit = Promise.withResolvers<void>()
  const setup: import('./child/instruction-context.ts').InitialChildSetup = {
    retire() { instructionAvailable = false; controller.abort(); try { instructionCleanup?.retire() } catch (error) { retirementFault = { error } } },
    close() {
      if (setupClosed || transferred) return Promise.resolve()
      if (setupFlight) return setupFlight
      const pending = (async () => {
        await setupExit.promise
        if (transferred) return
        instructionAvailable = false; controller.abort()
        const failures: unknown[] = []
        if (retirementFault) { failures.push(retirementFault.error); retirementFault = undefined }
        else try { instructionCleanup?.retire() } catch (error) { failures.push(error) }
        if (!mountCancelled) try { await cancelRuntime?.('Child preparation failed'); mountCancelled = true } catch (error) { failures.push(error) }
        if (!mountDisposed) try { await disposeRuntime?.(); mountDisposed = true } catch (error) { failures.push(error) }
        if (!initialClosed) try { await closeInitial?.(); initialClosed = true } catch (error) { failures.push(error) }
        if (failures.length) throw new AggregateError(failures, 'Original child setup producer cleanup incomplete')
        if (!instructionClosed) { await instructionCleanup?.close(); instructionClosed = true }
        if (failedInstructionInput && !failedInstructionSettled) {
          if (!failedSettlement) throw Object.assign(new Error('Original failed child instruction cleanup unavailable'), { code: 'FACT_RECOVERY_REQUIRED' })
          await failedSettlement(failedInstructionInput); failedInstructionSettled = true
        }
        if (!documentClosed) { await closeDocument?.(); documentClosed = true }
        if (!contextClosed) {
          if (contextCreated && !unmountContext) {
            if (contextFailure) throw contextFailure.cause
            throw new TypeError('Original child context cleanup unavailable')
          }
          await unmountContext?.()
          contextClosed = true
        }
        setupClosed = true; releaseSetup?.(); releaseSetup = undefined
      })()
      setupFlight = pending; void pending.catch(() => { if (setupFlight === pending) setupFlight = undefined }); return pending
    },
  }
  return invokeOriginal(setup, async () => { try {
  if (retainInitial) releaseSetup = retainInitial(setup)
  // Capture the original caller's result source while its admission is live.
  // This read-only host capability does not require a child context or model.
  if (results?.forSource) results = await results.forSource()
  if (captured) {
    hostBirth = await openHostChildBirth(captured, start, declared)
    document = hostBirth.document
    closeDocument = hostBirth.close
    revokeDocument = hostBirth.revoke
    sessionId = hostBirth.sessionId
  }
  controller.signal.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  controller.signal.throwIfAborted()
  childCtx = parentContext.scope.mount()
  contextCreated = true
  try {
    unmountContext = dataMethod<() => void>(childCtx.scope, 'unmount')?.bind(childCtx.scope)
    if (!unmountContext) throw new TypeError('Original child context cleanup unavailable')
  } catch (cause) {
    contextFailure = { cause }
    throw cause
  }
  childCtx.services.register("hooks/agent-type", role.name)
  controller.signal.throwIfAborted()
  controller.signal.throwIfAborted()
  const ordinary = (opts.childSessions?.origin ?? "subagent") === "subagent"
  const protocol = ordinary ? { subagentProtocolVersion: 1 as const } : {}
  const projection = ordinary ? { ...(opts.taskId ? { subagentTaskId: opts.taskId } : {}), ...(opts.agentPath ? { subagentAgentPath: opts.agentPath } : {}) } : {}
  if (committed) sessionId=committed.request.invocation.targetSessionId
  controller.signal.throwIfAborted()
  const opened = committed
    ? { session: committed.document.view, factOwner: committed.document, document: committed.document }
    : hostBirth
      ? { session: hostBirth.document.view, factOwner: hostBirth.document, document: hostBirth.document }
      : await openChildDocument(seedEvents,
    { ...(opts.childSessions ? { parentSession: opts.childSessions.parentSessionId } : {}), seedLength: seedEvents.length, origin: opts.childSessions?.origin ?? 'subagent', delegationDepth: childDepth, ...protocol, ...projection },
    opts.childSessions && sessionId ? { coordinator: opts.childSessions.coordinator, sessionId } : undefined)
  const { session: childSession, factOwner } = opened
  document = opened.document
  if (document && !closeDocument) { const close = dataMethod<() => Promise<void>>(document, 'close'), revoke = dataMethod<() => void>(document, 'revokeNewWork'); if (!close || !revoke) throw new TypeError('Original child document cleanup unavailable'); closeDocument = close.bind(document); revokeDocument = revoke.bind(document) }
  if(committed&&opts.childStart?.kind==='committed-child-birth')markTaskChildAdopted(opts.childStart.birth)
  controller.signal.throwIfAborted()
  if (createInstruction) {
    const input = { session: childSession, factOwner, lifetime: { available: () => instructionAvailable } }
    let returned: import('./child/instruction-context.ts').ChildInstructionContext
    try { returned = invokeOriginal(setup, () => createInstruction(input)) }
    catch (error) { failedInstructionInput = input; throw error }
    instruction = captureChildInstructionContext(returned, () => { instructionAvailable = false }, cleanup => { instructionCleanup = cleanup })
  }
  if (!instructionAvailable) { instruction?.retire(); throw Object.assign(new Error('Child instruction setup retired'), { code: 'FACT_CLOSED' }) }
  initial = await openInitialChildGeneration(opts, factOwner, sessionId, controller, start, () => model, hostBirth?.initial, captured)
  { const close = dataMethod<() => Promise<void>>(initial, 'close'); if (!close) throw new TypeError('Original child generation close unavailable'); closeInitial = close.bind(initial) }
  controller.signal.throwIfAborted()
  if (declared !== undefined) {
    const state = await resolveModel.call(opts, declared)
    if (state.status !== "ready") {
      throw new Error(`role '${opts.role.name}' cannot resolve its model: ${state.reason}`)
    }
    model = state.binding.client
    reasoningEffort = state.binding.reasoningEffort
    contextWindow = state.binding.contextWindow
    maxOutputTokens = state.binding.maxOutputTokens
    budgetBinding = state.binding.budgetBinding
    contextMetadata = state.binding.contextMetadata
    modelLabel = modelLabelOf(declared)
  }
  controller.signal.throwIfAborted()
  if(sessionId && opts.childSessions) await childCtx.emit('session/inherited',{
    sessionId,parentSessionId:captured ? captured.data.parentSessionId : opts.childSessions.parentSessionId,session:childSession,
  })

  warnInheritedSeed(childSession, contextWindow)

  const { childReg, codeModeMount, agent } = await assembleChild(opts, childCtx, childSession, factOwner, sessionId, childPath, model, reasoningEffort, contextWindow, maxOutputTokens, contextMetadata, budgetBinding, declared === undefined ? inheritedBindingForStep : undefined, controller, initial.sharedGeneration, instruction, mount => {
    const failures: unknown[] = []
    try { const cancel = dataMethod<(reason?: string) => Promise<void>>(mount, 'cancel'); if (!cancel) throw new TypeError('Original child Code Mode cancel unavailable'); cancelRuntime = cancel.bind(mount) }
    catch (error) { failures.push(error); cancelRuntime = async () => { throw error } }
    try { const dispose = dataMethod<() => Promise<void>>(mount, 'dispose'); if (!dispose) throw new TypeError('Original child Code Mode dispose unavailable'); disposeRuntime = dispose.bind(mount) }
    catch (error) { failures.push(error); disposeRuntime = async () => { throw error } }
    if (failures.length) throw failures[0]
  }, captured)
  controller.signal.throwIfAborted()
  const published = await publishChild(opts, childCtx, childSession, factOwner, document, sessionId, childPath, childReg, codeModeMount, controller, agent, modelLabel, initial, () => model, instruction, () => { instructionAvailable = false }, entry => { publishedEntry = entry;transferred = true; releaseSetup?.(); releaseSetup = undefined; setupExit.resolve() }, () => { if (!instructionAvailable) throw Object.assign(new Error('Child setup retired'), { code: 'FACT_CLOSED' }) }, { unmount: unmountContext!, revokeDocument, closeDocument, closeInitial, cancelMount: cancelRuntime, disposeMount: disposeRuntime }, captured?.data, { results })
  // Existing background-child lifetime begins at publication. The launching
  // turn's temporary cancellation fence applies to preparation only.
  signal?.removeEventListener('abort', abort)
  return published
  } catch (error) {
    const cleanupFailures: unknown[] = []
    try { signal?.removeEventListener('abort', abort) } catch (failure) { cleanupFailures.push(failure) }
    try { setup.retire() } catch (failure) { cleanupFailures.push(failure) }
    setupExit.resolve()
    try { if (publishedEntry) await publishedEntry.dispose?.(); else await setup.close() }
    catch (failure) { cleanupFailures.push(failure) }
    if (cleanupFailures.length) {
      throw Object.assign(new AggregateError([error, ...cleanupFailures], 'Original child setup cleanup incomplete', { cause: error }), { code: 'FACT_RECOVERY_REQUIRED' })
    }
    throw error
  } })
}
