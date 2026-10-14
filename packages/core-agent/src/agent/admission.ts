import { deriveMessages } from "@i-harness/core-session"
import { projectionFingerprint } from "@i-harness/token-meter"
import { prepareModelRequest, type LLMRequest } from "@i-harness/llm-seam"
import type { AgentConfig, AgentDeps } from "./types.ts"
import type { AgentContext } from "./context.ts"
import type { createStepInput } from "./step-input.ts"

export function stalePreparedInput(): Error { return Object.assign(new Error("Model-visible input remained unstable during prepared admission"), { code: "CONTEXT_INPUT_STALE" }) }
/** Hooks/inbox claims belong to the logical step. Rebuilds only prepare its current surface. */
export function createAdmission(deps: AgentDeps & AgentConfig, context: AgentContext, prepare: ReturnType<typeof createStepInput>) {
  const revision = () => projectionFingerprint({ messages: deriveMessages(deps.session), system: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
    tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(), effort: context.reasoningEffort, binding: context.metadata(), rewrite: context.projectionRevision() })
  return async function admit(abort: AbortSignal | undefined, scope: LLMRequest["requestScope"], getSteps: () => number, state = { staleRebuilds: 0, compacted: false }) {
    while (true) {
      abort?.throwIfAborted()
      context.refreshBinding()
      const selected = deps.model, bindingIdentity = deps.modelBindingIdentity?.()
      const bindingUnchanged = () => deps.model === selected && deps.modelBindingIdentity?.() === bindingIdentity && context.bindingIsCurrent()
      const before = revision()
      const { request, requestRevision } = prepare(abort, scope, getSteps)
      const initial = await prepareModelRequest(selected, request)
      abort?.throwIfAborted()
      if (!bindingUnchanged() || before !== revision()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      const { prepared, snapshot } = context.ownedBudget.assess(initial, context.contextWindow, context.outputCap, context.budgetCfg?.reserveRatio)
      deps.telemetry?.emit({ type: "provider/context", ts: Date.now(), data: {
        systemBytes: initial.measurement.input.components.system.textUtf8Bytes,
        schemaBytes: initial.measurement.input.components.toolSchemas.structuredBytes,
        estimatedInputTokens: snapshot.admissionInputTokens, estimateSource: snapshot.estimateSource, coverage: snapshot.coverage,
        reasoningTokens: snapshot.reasoningTokens, outputReserve: snapshot.outputReserve, capSupport: snapshot.capSupport,
      } })
      if (snapshot.coverage === "incomplete") throw new Error(snapshot.reason)
      let checkpointed = false
      const checkpoint = async () => {
        context.ownedBudget.checkpoint()
        await deps.flush?.()
        abort?.throwIfAborted()
        checkpointed = true
      }
      const automatic = deps.autoCompactionEnabled?.() ?? context.compactEnabled
      if (context.compactor && !state.compacted && (snapshot.admission === "compact" || automatic)) {
        // This pass may invoke a summary model. Its preceding budget fact must
        // have passed the same durable barrier as a main transport.
        await checkpoint()
        if (!bindingUnchanged() || before !== revision()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
        state.compacted = true
        const result = snapshot.admission === "compact" ? await context.compactor.compact(deps.session)
          : automatic ? await context.compactor.maybeCompact(deps.session) : undefined
        abort?.throwIfAborted()
        if (!bindingUnchanged() || before !== revision() || result?.compacted) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      }
      if (snapshot.admission === "compact") throw new Error(`prompt_too_long: prepared context cannot fit the owned window (${snapshot.admissionInputTokens} input tokens; ${snapshot.outputReserve} output reserve)`)
      // Legacy custom clients with no host window remain source-compatible and
      // explicitly neutral-only/unavailable. No window is invented.
      if (!checkpointed) await checkpoint()
      if (!bindingUnchanged() || before !== revision()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      const validateBeforeTransport = () => {
        abort?.throwIfAborted()
        if (!bindingUnchanged() || before !== revision()) throw stalePreparedInput()
        const stateNow = context.ownedBudget.read()
        if (stateNow.kind === "ready" && stateNow.snapshot.recoveryRequired && !snapshot.recoveryRequired) throw new Error("prompt_too_long: provider context recovery became required before transport")
      }
      validateBeforeTransport()
      return { request, requestRevision, prepared, validateBeforeTransport }
    }
  }
}
