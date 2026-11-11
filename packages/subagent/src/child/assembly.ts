import type { CapturedHostChildInput } from './host-birth.ts'
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin'
import { createAgentModelOriginOwner } from '@i-harness/core-agent/model-origin'
import { isNondurableSession } from '@i-harness/core-session'
import { ownedContextReadiness } from "@i-harness/session-persistence"
import type { PluginContext } from "@i-harness/core-plugin"
import type { SessionView, FactOwner } from "@i-harness/core-session"
import { createToolRegistry, registerContextRemaining } from "@i-harness/core-tools"
import { createAgent, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SpawnOptions } from "./types.ts"
import { composeSubagentPrompt, estimateChildOverhead } from "./prompt.ts"
import { resolveRoleTools } from "./role-tools.ts"

export async function assembleChild(
  opts: SpawnOptions, childCtx: PluginContext, childSession: SessionView, factOwner: FactOwner,
  sessionId: string | undefined, childPath: string, model: ModelClient,
  reasoningEffort: ReasoningEffort | undefined, contextWindow: number | undefined, maxOutputTokens: number | undefined,
  contextMetadata?: import("@i-harness/core-session").ContextBindingMetadata,
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding,
  inheritedBindingForStep?: SpawnOptions["inheritedBindingForStep"],
  suppliedController?: AbortController,
  sharedGeneration?: object,
  instruction?: import('./instruction-context.ts').ChildInstructionContext,
  retainRuntime?: (mount: import('@i-harness/code-mode').CodeModeMount) => void,
  captured?: CapturedHostChildInput,
) {
  const role = captured ? captured.data.role : opts.role
  const timeoutMs = captured ? captured.data.modelActionTimeoutMs : opts.modelActionTimeoutMs
  const maxAttempts = captured ? captured.data.modelActionMaxAttempts : opts.modelActionMaxAttempts
  const factory = captured ? captured.generationFactory : opts.generationFactoryFor
  const coordinator = captured ? captured.coordinator : opts.childSessions?.coordinator
  // child registry: register the role's allowed tools (resolved from the parent).
  // A declared tool the host does not mount is reported, never dropped silently.
  const modelOrigins = !sharedGeneration && !isNondurableSession(childSession) ? createAgentModelOriginOwner({view:childSession,factOwner}) : undefined
  const modelPair = modelOrigins ? createToolRegistryWithModelOrigin(childCtx, { inheritResultRetention: opts.parentRegistry, executionOwner: {view:childSession,factOwner,context:childCtx,...sessionId!==undefined?{sessionId}:{}} }, modelOrigins.verifier) : undefined
  const childReg = modelPair?.registry ?? createToolRegistry(childCtx, { inheritResultRetention: opts.parentRegistry, executionOwner: {view:childSession,factOwner,context:childCtx,...sessionId!==undefined?{sessionId}:{}} })
  const modelCallOrigin = modelPair && modelOrigins!.bind(childReg, modelPair.driver)
  // The host factory mounts the child's OWN shell tools (its own execution
  // context). Without it, resolveRoleTools falls back to the legacy inherited
  // tools, whose parent-bound direct entry cannot run in a child context.
  if (opts.childShellFactory) await opts.childShellFactory({ ctx: childCtx, tools: childReg, session: childSession, factOwner, ...(sessionId !== undefined ? { sessionId } : {}) })
  resolveRoleTools(role.name, role.tools, opts.parentRegistry, childReg)
  const codeModeMount = role.tools.length === 0 ? undefined : opts.codeModeFactory?.(childCtx, childReg, {
    session: childSession, factOwner, sessionId, config: opts.codeMode,
  })
  // The initial setup owns original cleanup before ready can await or fail.
  if (codeModeMount) retainRuntime?.(codeModeMount)
  await codeModeMount?.ready?.()
  const modelToolSchemas = () => codeModeMount?.schemas() ?? childReg.schemas()

  // M73: the prompt is composed ONCE — the agent gets it, and the overhead
  // estimate below prices it.
  const childPrompt = composeSubagentPrompt(role.systemPrompt, { path: childPath, role: role.name, tools: modelToolSchemas().map(tool => tool.name) })
  const systemPrompt = opts.inheritedSystemContext ? () => {
    const inherited = opts.inheritedSystemContext!(childSession)
    return inherited ? `${childPrompt}\n\n${inherited}` : childPrompt
  } : childPrompt
  // The charge the child's log never carries but the model sees on every
  // request: its composed prompt and its tool schemas' JSON — priced the way the
  // session's own assembly prices the same pair (assembly.ts's
  // estimateAssemblyOverhead), against the char/token constant token-meter owns.
  // Absent window → absent overhead: `budget` needs a window anyway.
  const overheadTokens = contextWindow === undefined
    ? undefined
    : estimateChildOverhead(typeof systemPrompt === "function" ? systemPrompt() : systemPrompt, modelToolSchemas())
  const modelOverheadTokens = () => estimateChildOverhead(typeof systemPrompt === "function" ? systemPrompt() : systemPrompt, modelToolSchemas())

  const controller = suppliedController ?? new AbortController()
  const agent = createAgent(childCtx, {
      modelCallOrigin,
    ...(sharedGeneration ? { sharedGeneration } : sessionId && factory ? { generationFactory: factory.call(captured?.receiver ?? opts, factOwner, sessionId, () => model) } : {}),
    modelActionTimeoutMs: timeoutMs, modelActionMaxAttempts: maxAttempts,
    summaryFactory: opts.summaryFactory,
    ...(inheritedBindingForStep ? { bindingForStep: inheritedBindingForStep } : {}),
    isSubagent: true,
    ...(coordinator && sessionId ? { ensureWritableContext: ownedContextReadiness(coordinator, sessionId, childSession) } : {}),
    ...(opts.autoCompactionEnabled ? { autoCompactionEnabled: opts.autoCompactionEnabled } : {}),
    session: childSession,
    factOwner,
    ...(instruction ? { requestContext: instruction.requestContext } : {}),
    tools: childReg,
    modelToolSchemas,
    ...(codeModeMount ? { modelOverheadTokens } : {}),
    model,
    budgetBinding,
    contextMetadata,
    // M49 Task 14 (spec §11): role prompt + the subagent contract (scope/
    // delegation/changed-files+test reporting/result delivery). Human and
    // project instructions remain higher priority (the contract says so).
    systemPrompt,
    signal: controller.signal,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    // M73: the budget this child's requests carry. Before this, a child ran
    // unbounded — no cap (per-provider max_tokens absent, so on anthropic the
    // adapter's own unclamped fallback went to the wire) and no window (the
    // budget ladder cannot even fire without one). Both come from the same
    // place the main session's do.
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    // M73: the window the child's budget ladder measures with (the cap above is
    // what the request carries; this is what it is clamped against). Before it,
    // a windowless child sent the over-window request and let the provider
    // answer it — a 400 the harness could not see coming. The ladder's LAST
    // layer is still reachable (compaction + reset can both fail to bring the
    // surface back), and it still fails closed: pinned by "a child past its
    // window FAILS CLOSED" in test/child.test.ts.
    ...(contextWindow !== undefined
      ? { budget: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
    // M74: the child's OWN compactor. Without it the ladder's first two layers
    // are unreachable (core-agent builds one only from `compact`) and a child
    // past `window * 0.9` has exactly one layer left — the fail-closed throw.
    // With it, the pass shadows the region and the turn continues; the 10%
    // between the pressure gate (0.8) and the budget (0.9) is its head start.
    // `requestShape` needs no wiring here: core-agent builds it from THIS
    // child's systemPrompt and tools, so the summarizer's call is a byte-prefix
    // of the child's own request (the provider cache serves it). `auto` is not
    // written — it defaults true. A live host preference, when supplied above,
    // is read by core-agent at each step, including for this existing child.
    // M74 (final review) / M75: when the child's surface exceeds the window,
    // the summarizer's single request — the whole inherited surface plus the
    // directive, prompt and schemas, retaining the actual required output floor
    // when no legal derivative fits — is one a strict
    // provider rejects. M75 answers that with CHAINED PIECES: whenever the
    // request cannot fit and the region can be sliced (the gate wants all four
    // — a region, a request shape, a resolved cap, a window — and a child
    // supplies each: the engine's own compact pass names the region, core-agent
    // builds the shape, the role binding resolves the numbers), the summarizer
    // summarises the region piece by piece and the child keeps its inherited
    // context as a SUMMARY. What remains of the old regime is the
    // region NO piece can fit — one indivisible block (design §4.4) — where the
    // pass still fails soft and the ladder's reset still rescues the turn with
    // the inherited context DROPPED. Pinned by "on a strict provider the child
    // still completes" (the indivisible fixture) and "an over-window child
    // region that CAN be split is summarised" (the divisible one) in
    // test/child.test.ts.
    ...(contextWindow !== undefined
      ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
    // Retained results and prepared calls keep the child's durable identity.
    ...(sessionId !== undefined ? { sessionId } : {}),
  })
  if (childReg.get("get_context_remaining")) {
    childReg.unregister("get_context_remaining")
    registerContextRemaining(childCtx, childReg, { contextWindow, budgetRead: () => agent.contextBudget!() })
  }
  return { childReg, codeModeMount, controller, agent }
}
