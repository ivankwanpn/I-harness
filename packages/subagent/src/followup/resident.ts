import { ownedContextReadiness } from "@i-harness/session-persistence"
import { createToolRegistry, registerContextRemaining } from "@i-harness/core-tools"
import { createAgent, type ReasoningEffort } from "@i-harness/core-agent"
import type { ChildAgentEntry } from "../agent-table.ts"
import type { SubagentToolDeps } from "../tools/types.ts"
import type { FollowupDeps } from "./drive.ts"
import { composeSubagentPrompt, declaredRoleModel, estimateChildOverhead, modelLabelOf, resolveRoleTools, subagentModelSelectionGated } from "../child.ts"
import { childFactOwner } from '../child/document.ts'
import { captureFollowupGenerationIntent, openFollowupGeneration } from './generation.ts'
import { ResidentPreparation, residentOwnerFor, invokeOriginal } from './resident-lifetime.ts'

// M23 (Minor 4): lazy resident rebuild, extracted verbatim from resume_agent's
// rebuild body (M19). On resume the subagent Agent registry is fresh-empty
// (entries are registered per spawn/turn), so a wakeup for a restored teammate
// found no resident agent and silently dropped the drive. This rebuilds the
// resident agent from the restored entry (durable session + role + model):
//   - returns true when the entry is already resident OR the rebuild succeeded
//   - returns false when it cannot rebuild (unknown role / unknown provider) —
//     the CALLER decides the fail behavior (resume_agent throws; the wakeup
//     paths just drop the drive like before)
export async function ensureResidentAgent(deps: SubagentToolDeps, entry: ChildAgentEntry, executionController?: AbortController, executionCurrent: () => boolean = () => true): Promise<boolean> {
  if (entry.sessionId) {
    const resident = deps.agents.get(entry.sessionId)
    if (resident) return true
  }
  const role = deps.roles.get(entry.roleName ?? "general")
  if (!role) return false
  // The model decision comes BEFORE the scope is mounted: a refused rebuild
  // must leave nothing behind, and this refusal is decidable without one. A
  // selection the `plugins.subagentModel` switch does not allow fails the
  // rebuild — returning false, never inheriting: a restored child of a role
  // that names a model must not come back on a different one. False (not a
  // throw) is this function's contract — the callers decide the fail behaviour
  // and the sweep must never throw — and `resume_agent` re-derives the message
  // from the same helper spawnChild throws.
  const declared = declaredRoleModel(role, deps)
  if (subagentModelSelectionGated(deps, declared)) return false
  // Lookup/admission is a pure eligibility probe. Only the actual serialized
  // inbox executor supplies a controller after opening its durable origin.
  if (!executionController) return true
  if (residentOwnerFor(deps).retired || !executionCurrent()) return false
  if (entry.dispose) return false // Never replace an original in-progress owner.
  executionController.signal.throwIfAborted()
  const record = new ResidentPreparation(deps, entry)
  const createInstructionContext = deps.createInstructionContext
  const resolveModel = deps.resolveModel.bind(deps), mountCodeMode = deps.codeModeFactory?.bind(deps)
  entry.dispose = record.dispose
  let installed = false, codeModeMount: import('@i-harness/code-mode').CodeModeMount | undefined
  try {
  const factOwner = await invokeOriginal(record, () => childFactOwner(entry, deps.childSessions?.coordinator))
  if (!record.factOwner && entry.session === record.view) record.bindFactOwner(factOwner)
  // Nonintegrated embedders may obtain their nondurable owner at this boundary.
  if (!executionCurrent() || !record.current()) return false
  executionController.signal.throwIfAborted()
  const childCtx = record.ctx = invokeOriginal(record, () => deps.parentCtx.scope.mount())
  if (!executionCurrent() || !record.current()) return false
  executionController.signal.throwIfAborted()
  if (createInstructionContext) record.instruction = invokeOriginal(record, () => createInstructionContext({
    session: record.view, factOwner, lifetime: { available: () => record.current() },
  }))
  if (!executionCurrent() || !record.current()) return false
  executionController.signal.throwIfAborted()
  const childReg = createToolRegistry(childCtx, { inheritResultRetention: deps.parentRegistry })
  record.registry = childReg
  // Same resolution as spawnChild — a declared-but-unmounted tool is reported.
  resolveRoleTools(role.name, role.tools, deps.parentRegistry, childReg)
  // model resolution identical to spawnChild (child.ts): the declared selection
  // (settings first, then role.model) → the host's resolver; else inherit the
  // parent model. The binding's `reasoningEffort` rides along for the same
  // reason it does at spawn: a rebuild that kept only the client would run the
  // same model at the adapter default.
  let model = deps.parentModel
  let reasoningEffort: ReasoningEffort | undefined = deps.reasoningEffort
  let budgetBinding = deps.budgetBinding
  let contextMetadata = deps.contextMetadata
  // M73: the same two numbers spawnChild carries, from the same two sources —
  // a rebuild is a spawn with a restored log, and a budget that appeared only
  // on the first one would vanish on every resume.
  let contextWindow = deps.contextWindow
  let maxOutputTokens = deps.maxOutputTokens
  if (declared !== undefined) {
    const state = await invokeOriginal(record, () => resolveModel(declared))
    if (state.status !== "ready") return false
    model = state.binding.client
    reasoningEffort = state.binding.reasoningEffort
    contextWindow = state.binding.contextWindow
    maxOutputTokens = state.binding.maxOutputTokens
    budgetBinding = state.binding.budgetBinding
    contextMetadata = state.binding.contextMetadata
  }
  if (!executionCurrent() || !record.current()) {
    return false
  }
  executionController.signal.throwIfAborted()
  // The label records what the child runs on NOW, and a rebuild can move it
  // EITHER way: a settings entry added while the toggle is on moves an
  // inheriting entry to labeled, and one removed moves it back. Assigning only
  // in the labeled direction would leave the second case printing "inherited
  // from the session" while it runs on a configured model. (The switch-off and
  // non-ready arms returned above — those rebuilds change nothing, so the label
  // still describes the client the child was last left on.)
  const modelLabel = declared !== undefined ? modelLabelOf(declared) : undefined
  const childCoordinator = deps.childSessions?.coordinator
  const childSessionId = entry.sessionId
  codeModeMount = record.mount = role.tools.length === 0 ? undefined : invokeOriginal(record, () => mountCodeMode?.(childCtx, childReg, {
    session: entry.session, factOwner, sessionId: childSessionId, config: deps.codeMode,
  }))
  await invokeOriginal(record, () => record.readyMount?.())
  if (!executionCurrent() || !record.current()) return false
  executionController.signal.throwIfAborted()
  const modelToolSchemas = () => codeModeMount?.schemas() ?? childReg.schemas()
  // M73 defect #2: this call used `role.systemPrompt` where spawn uses the
  // COMPOSED prompt — so a rebuilt child silently lost SUBAGENT_PROMPT_CONTRACT
  // (scope / delegation / result-delivery), which child.ts's own comment says
  // rides "every child agent". Same composer, same place, one call site each.
  const childPrompt = composeSubagentPrompt(role.systemPrompt, { path: entry.path, role: role.name, tools: modelToolSchemas().map(tool => tool.name) })
  const systemPrompt = deps.inheritedSystemContext ? () => {
    const inherited = deps.inheritedSystemContext!(entry.session)
    return inherited ? `${childPrompt}\n\n${inherited}` : childPrompt
  } : childPrompt
  // M73: the charge the child's log never carries but the model sees on every
  // request — priced by child.ts's ONE definition (imported, not copied: two
  // copies of that rule are two places to drift). Absent window → absent
  // overhead: `budget` needs a window anyway.
  const overheadTokens = contextWindow === undefined
    ? undefined
    : estimateChildOverhead(typeof systemPrompt === "function" ? systemPrompt() : systemPrompt, modelToolSchemas())
  const modelOverheadTokens = () => estimateChildOverhead(typeof systemPrompt === "function" ? systemPrompt() : systemPrompt, modelToolSchemas())
  const controller = executionController
  if (!executionCurrent() || !record.current()) return false
  const agent = record.agent = invokeOriginal(record, () => createAgent(childCtx, {
    ...(entry.sessionId && deps.generationFactoryFor ? { generationFactory: deps.generationFactoryFor(factOwner, entry.sessionId, () => model) } : {}),
    modelActionTimeoutMs: deps.modelActionTimeoutMs, modelActionMaxAttempts: deps.modelActionMaxAttempts,
    summaryFactory: deps.summaryFactory,
    ...(declared === undefined && deps.inheritedBindingForStep ? { bindingForStep: deps.inheritedBindingForStep } : {}),
    isSubagent: true,
    ...(childCoordinator && childSessionId ? { ensureWritableContext: ownedContextReadiness(childCoordinator, childSessionId, entry.session) } : {}),
    ...(deps.autoCompactionEnabled ? { autoCompactionEnabled: deps.autoCompactionEnabled } : {}),
    session: entry.session, factOwner, tools: childReg, model,
    requestContext: record.instruction?.requestContext,
    budgetBinding,
    contextMetadata,
    modelToolSchemas,
    ...(codeModeMount ? { modelOverheadTokens } : {}),
    systemPrompt, signal: controller.signal,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    // M73: the cap and the window the rebuilt child's requests carry, from the
    // same two sources the model decision above read. Absent stays absent — a
    // rebuild that invents a number would be one nobody chose.
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(contextWindow !== undefined
      ? { budget: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
    // M74: the rebuilt child gets its OWN compactor too — same key, same source,
    // same shape as the spawn site (child.ts). A compactor built only at the
    // first spawn would vanish on every resume: the rebuilt agent is a fresh
    // `createAgent`, and without this spread a child that was compacting before
    // the restart falls back to the fail-closed throw at the next pressure
    // boundary. Same two locals, nothing re-derived.
    ...(contextWindow !== undefined
      ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
    // M19 (Ruling 24): attribute the resumed child's tool calls to its
    // team member via the durable session id.
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
  }))
  if (childReg.get("get_context_remaining")) {
    childReg.unregister("get_context_remaining")
    registerContextRemaining(childCtx, childReg, { contextWindow, budgetRead: () => agent.contextBudget!() })
  }
  if (!executionCurrent() || !record.current()) return false
  if (entry.sessionId) deps.agents.register(entry.sessionId, agent)
  record.phase = 'installed'
  deps.table.update(entry.path, entry, {
    resultLifetime: () => record.resultLifetime,
    executionModel: () => model,
    status: "waiting", controller, toolRegistry: childReg, modelLabel,
    factoryTools: [...(codeModeMount ? ["code_exec", "code_wait"] : []), "get_context_remaining"].flatMap((name) => { const tool = childReg.get(name); return tool ? [tool] : [] }),
    unmount: record.unmount,
    cancel: codeModeMount ? (reason) => codeModeMount!.cancel(reason) : undefined,
    dispose: record.dispose,
  })
  if (!executionCurrent() || !record.current()) return false
  installed = true
  return true
  } catch (error) {
    record.setupOutcome = { occurred: true, value: error }
    throw error
  } finally {
    record.setupExit.resolve()
    if (!installed) {
      record.failed()
      // The driver's outer finally must get to signal bodyExit. This cleanup
      // never waits that body from inside its own suspended setup.
      if (residentOwnerFor(deps).generations(entry).length) void record.close().catch(() => {})
      else await record.close()
    }
  }
}

// M23 (Minor 4): the FollowupDeps passed to driveFollowups from the subagent
// tools carries the lazy rebuild so a wakeup for a restored (fresh-registry)
// entry recovers the resident agent instead of silently dropping the drive.
export function followupDepsWithRebuild(deps: SubagentToolDeps): FollowupDeps {
  return { results: deps.results, agents: deps.agents, table: deps.table, jobs: deps.jobs, activation: deps.residentActivation,
    captureGeneration: (entry, input) => captureFollowupGenerationIntent(deps, entry, input),
    rebuild: (entry, controller, current) => ensureResidentAgent(deps, entry, controller, current),
    openGeneration: (entry, input, controller, intent, current) => openFollowupGeneration(deps, entry, input, controller, intent, current) }
}
