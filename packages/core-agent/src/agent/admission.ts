import { sameRequestCandidate } from "./request-snapshot.ts"
import { prepareModelRequest, type LLMRequest } from "@i-harness/llm-seam"
import type { AgentConfig, AgentDeps } from "./types.ts"
import type { AgentContext } from "./context.ts"
import type { createStepInput } from "./step-input.ts"
import type { createRecovery, RecoveryAdmissionState } from "./recovery.ts"

export function stalePreparedInput(): Error { return Object.assign(new Error("Model-visible input remained unstable during prepared admission"), { code: "CONTEXT_INPUT_STALE" }) }
/** Hooks/inbox claims belong to the logical step. Rebuilds only prepare its current surface. */
export function createAdmission(deps: AgentDeps & AgentConfig, context: AgentContext, prepare: ReturnType<typeof createStepInput>, recovery: ReturnType<typeof createRecovery>) {
  return async function admit(abort: AbortSignal | undefined, scope: LLMRequest["requestScope"], getSteps: () => number, state: RecoveryAdmissionState & { staleRebuilds: number; compacted: boolean } = { staleRebuilds: 0, compacted: false }) {
    while (true) {
      abort?.throwIfAborted()
      context.refreshBinding()
      const captured = context.captureCandidate()
      const current = () => context.bindingIsCurrent() && sameRequestCandidate(captured, context.captureCandidate())
      const { request, requestRevision } = prepare(abort, scope, getSteps, captured)
      const initial = await prepareModelRequest(captured.model, request)
      abort?.throwIfAborted()
      if (!current()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      const assess = (authorized = false) => context.ownedBudget.assess(initial, captured, captured.snapshot.surface.contextWindow, captured.snapshot.surface.maxOutputTokens, context.budgetCfg?.reserveRatio, authorized)
      const assessed = assess()
      const recoveryAdmission = await recovery.admit(initial.measurement, state, abort)
      if (recoveryAdmission === "rebuild") { state.compacted = true; continue }
      if (!current()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      const { prepared, snapshot } = recoveryAdmission === "authorized"
        ? assess(true) : assessed
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
      if (context.compactor && !state.compacted && recoveryAdmission !== "authorized" && (snapshot.admission === "compact" || automatic)) {
        // This pass may invoke a summary model. Its preceding budget fact must
        // have passed the same durable barrier as a main transport.
        await checkpoint()
        if (!current()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
        state.compacted = true
        let result
        try {
          result = snapshot.admission === "compact" ? await context.compactor.compact(deps.session, undefined, { signal: abort })
            : automatic ? await context.compactor.maybeCompact(deps.session, { signal: abort }) : undefined
        } catch (error) {
          if ((error as { code?: string })?.code !== "CONTEXT_INPUT_STALE") throw error
          state.compacted = false
          if (++state.staleRebuilds > 3) throw stalePreparedInput()
          continue
        }
        abort?.throwIfAborted()
        if (!current() || result?.compacted) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      }
      if (snapshot.admission === "compact") throw new Error(`prompt_too_long: prepared context cannot fit the owned window (${snapshot.admissionInputTokens} input tokens; ${snapshot.outputReserve} output reserve)`)
      // Legacy custom clients with no host window remain source-compatible and
      // explicitly neutral-only/unavailable. No window is invented.
      if (!checkpointed) await checkpoint()
      if (!current()) { if (++state.staleRebuilds > 3) throw stalePreparedInput(); continue }
      const validateBeforeTransport = () => {
        abort?.throwIfAborted()
        if (!current()) throw stalePreparedInput()
        recovery.validate(prepared.measurement, state)
        const stateNow = context.ownedBudget.read()
        if (stateNow.kind === "ready" && stateNow.snapshot.recoveryRequired && !snapshot.recoveryRequired) throw new Error("prompt_too_long: provider context recovery became required before transport")
      }
      validateBeforeTransport()
      return { request, requestRevision, prepared, validateBeforeTransport }
    }
  }
}
