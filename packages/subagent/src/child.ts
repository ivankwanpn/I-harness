import { randomUUID } from "node:crypto"
import type { ReasoningEffort } from "@i-harness/core-agent"
import { forkTurns } from "./fork.ts"
import { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
import type { SpawnOptions } from "./child/types.ts"
import { assembleChild } from "./child/assembly.ts"
import { publishChild, warnInheritedSeed } from "./child/lifecycle.ts"
import { openChildDocument } from './child/document.ts'

export { SUBAGENT_PROMPT_CONTRACT, composeSubagentPrompt, estimateChildOverhead } from "./child/prompt.ts"
export { resolveRoleTools } from "./child/role-tools.ts"
export { declaredRoleModel, modelLabelOf, subagentModelSelectionDisabled, subagentModelSelectionGated } from "./child/model-binding.ts"
export type { RoleModelHost, RoleModelSelection, RoleModelState } from "./child/model-binding.ts"
export type { SpawnOptions } from "./child/types.ts"

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string; modelLabel?: string }> {
  // Gate precedes mounting; resolution retains its original post-mount position.
  const declared = declaredRoleModel(opts.role, opts)
  if (subagentModelSelectionGated(opts, declared)) throw subagentModelSelectionDisabled(opts.role.name)
  if (opts.childSessions && !opts.childSessions.coordinator.openManagedDocument) throw Object.assign(new Error('Durable child requires the owned fact capability'), { code: 'FACT_OWNER_UNSUPPORTED' })

  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()
  childCtx.services.register("hooks/agent-type", opts.role.name)

  // Allocate inherited seed and read depth before resolving the model.
  const turns = opts.forkTurns ?? "none"
  const seedEvents = turns === "none" ? [] : forkTurns(opts.parentSession.events, turns === "all" ? Infinity : turns, opts.parentSession.formatVersion)

  let sessionId: string | undefined
  const childDepth = (opts.parentSession.header?.delegationDepth ?? 0) + 1

  let model = opts.parentModel
  let reasoningEffort: ReasoningEffort | undefined = opts.reasoningEffort
  let budgetBinding = opts.budgetBinding
  let contextMetadata = opts.contextMetadata
  let contextWindow = opts.contextWindow
  let maxOutputTokens = opts.maxOutputTokens
  let modelLabel: string | undefined
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

  // The durable create and inherited lifecycle emit keep their original awaits.
  if (opts.childSessions) {
    sessionId = `child-${randomUUID()}`
    await opts.childSessions.coordinator.create({
      sessionId,
      parentSession: opts.childSessions.parentSessionId,
      seedLength: seedEvents.length,
      origin: opts.childSessions.origin ?? "subagent",
      delegationDepth: childDepth,
    })
  }
  const { session: childSession, factOwner, document } = await openChildDocument(seedEvents,
    { ...(opts.childSessions ? { parentSession: opts.childSessions.parentSessionId } : {}), seedLength: seedEvents.length, origin: opts.childSessions?.origin ?? 'subagent', delegationDepth: childDepth },
    opts.childSessions && sessionId ? { coordinator: opts.childSessions.coordinator, sessionId } : undefined)
  if(sessionId && opts.childSessions) await childCtx.emit('session/inherited',{
    sessionId,parentSessionId:opts.childSessions.parentSessionId,session:childSession,
  })

  warnInheritedSeed(childSession, contextWindow)

  const { childReg, codeModeMount, controller, agent } = await assembleChild(opts, childCtx, childSession, factOwner, sessionId, childPath, model, reasoningEffort, contextWindow, maxOutputTokens, contextMetadata, budgetBinding, declared === undefined ? opts.inheritedBindingForStep : undefined)
  return publishChild(opts, childCtx, childSession, factOwner, document, sessionId, childPath, childReg, codeModeMount, controller, agent, modelLabel)
}
