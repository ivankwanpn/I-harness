import { randomUUID } from "node:crypto"
import type { ReasoningEffort } from "@i-harness/core-agent"
import { forkTurns } from "./fork.ts"
import { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
import type { SpawnOptions } from "./child/types.ts"
import { assembleChild } from "./child/assembly.ts"
import { publishChild, warnInheritedSeed } from "./child/lifecycle.ts"
import { openChildDocument } from './child/document.ts'
import { openInitialChildGeneration, type InitialChildInput } from './child/generation.ts'

export { SUBAGENT_PROMPT_CONTRACT, composeSubagentPrompt, estimateChildOverhead } from "./child/prompt.ts"
export { resolveRoleTools } from "./child/role-tools.ts"
export { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
export type { RoleModelHost, RoleModelSelection, RoleModelState } from "./child/model-binding.ts"
export type { SpawnOptions } from "./child/types.ts"

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string; modelLabel?: string }> {
  // Pure role gates precede any child document or executable model resolution.
  const declared = declaredRoleModel(opts.role, opts)
  if (subagentModelSelectionGated(opts, declared)) throw subagentModelSelectionDisabled(opts.role.name)
  if (opts.childSessions && !opts.childSessions.coordinator.openManagedDocument) throw Object.assign(new Error('Durable child requires the owned fact capability'), { code: 'FACT_OWNER_UNSUPPORTED' })

  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()
  childCtx.services.register("hooks/agent-type", opts.role.name)

  // Allocate inherited seed and read depth before resolving the model.
  const turns = opts.forkTurns ?? "none"
  const seedEvents = turns === "none" ? [] : forkTurns(opts.parentSession.events, turns === "all" ? Infinity : turns, opts.parentSession.formatVersion, opts.parentSession.header)

  let sessionId: string | undefined
  const childDepth = (opts.parentSession.header?.delegationDepth ?? 0) + 1
  const start = { wall: Date.now(), monotonic: performance.now() }
  const controller = new AbortController()
  const abort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()

  let model = opts.parentModel
  let reasoningEffort: ReasoningEffort | undefined = opts.reasoningEffort
  let budgetBinding = opts.budgetBinding
  let contextMetadata = opts.contextMetadata
  let contextWindow = opts.contextWindow
  let maxOutputTokens = opts.maxOutputTokens
  let modelLabel: string | undefined
  let initial: InitialChildInput | undefined
  let document: import('@i-harness/session-persistence').ManagedDocument | undefined
  let preparedRuntime: import('@i-harness/code-mode').CodeModeMount | undefined
  try {
  controller.signal.throwIfAborted()
  if (opts.childSessions) {
    sessionId = `child-${randomUUID()}`
    await opts.childSessions.coordinator.create({ sessionId,
      parentSession: opts.childSessions.parentSessionId, seedLength: seedEvents.length,
      origin: opts.childSessions.origin ?? "subagent", delegationDepth: childDepth })
  }
  const opened = await openChildDocument(seedEvents,
    { ...(opts.childSessions ? { parentSession: opts.childSessions.parentSessionId } : {}), seedLength: seedEvents.length, origin: opts.childSessions?.origin ?? 'subagent', delegationDepth: childDepth },
    opts.childSessions && sessionId ? { coordinator: opts.childSessions.coordinator, sessionId } : undefined)
  const { session: childSession, factOwner } = opened
  document = opened.document
  initial = await openInitialChildGeneration(opts, factOwner, sessionId, controller, start, () => model)
  controller.signal.throwIfAborted()
  if (declared !== undefined) {
    const state = await opts.resolveModel(declared)
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
    sessionId,parentSessionId:opts.childSessions.parentSessionId,session:childSession,
  })

  warnInheritedSeed(childSession, contextWindow)

  const { childReg, codeModeMount, agent } = await assembleChild(opts, childCtx, childSession, factOwner, sessionId, childPath, model, reasoningEffort, contextWindow, maxOutputTokens, contextMetadata, budgetBinding, declared === undefined ? opts.inheritedBindingForStep : undefined, controller, initial.sharedGeneration)
  preparedRuntime = codeModeMount
  controller.signal.throwIfAborted()
  const published = await publishChild(opts, childCtx, childSession, factOwner, document, sessionId, childPath, childReg, codeModeMount, controller, agent, modelLabel, initial, () => model)
  // Existing background-child lifetime begins at publication. The launching
  // turn's temporary cancellation fence applies to preparation only.
  opts.signal?.removeEventListener('abort', abort)
  return published
  } catch (error) {
    opts.signal?.removeEventListener('abort', abort)
    try { await preparedRuntime?.cancel('Child preparation failed'); await preparedRuntime?.dispose(); await initial?.close() }
    finally { try { await document?.close() } finally { await childCtx.scope.unmount() } }
    throw error
  }
}
