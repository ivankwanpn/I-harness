import type { SessionModelState } from "@i-harness/sdk"
import type { SessionContextState } from "@i-harness/sdk/context"

/** A prepared input estimate and a completed request's measured input are
 * different readings. Neither grants permission to send the next request. */
export function contextOccupancy(state?: SessionContextState, selected?: SessionModelState) {
  const observation = state?.observation
  const legacyReady = !observation && state?.kind === "ready" ? state : undefined
  const identity = observation ?? state?.snapshot
  const identifiesModel = identity && !(identity.protocol === "custom" && identity.modelId === "unknown")
  const modelChanged = !!(selected && identity && (selected.status !== "ready" ||
    identity.providerId !== undefined && selected.providerId !== identity.providerId ||
    identifiesModel && (selected.modelId !== identity.modelId || selected.protocol !== undefined && selected.protocol !== identity.protocol)))
  const estimate = observation?.estimate.kind === "estimated" ? observation.estimate : undefined
  const pressure = observation?.pressure.kind === "known" ? observation.pressure : undefined
  const verifiedBudget = pressure?.basis === "input-only" || pressure?.basis === "shared-context" &&
    (observation?.output.effectiveCap !== undefined || observation?.output.allowance !== undefined)
  const inputBudget = verifiedBudget && pressure && pressure.inputBudget > 0 ? pressure.inputBudget : undefined
  const dimension = observation?.dimensions.find(item => item.dimension === "context")
  const limit = observation?.reason !== "capacity-conflict" && dimension?.sourceId !== undefined &&
    (dimension.state !== "fail" || pressure !== undefined) ? dimension.limit : undefined
  const modelWindow = limit !== undefined && limit > 0 ? limit : legacyReady?.contextWindow
  const historical = observation !== undefined && observation.freshness !== "current"
  const warning = !modelChanged && !!(observation?.fullByProvider || observation?.recoveryRequired ||
    observation?.disposition === "reduce" || observation?.disposition === "blocked" || pressure && !pressure.hardFits)
  const measured = !modelChanged && historical && !warning ? state?.lastReportedInputTokens : undefined
  const tokens = modelChanged ? undefined : measured ?? estimate?.value ?? legacyReady?.estimatedTokens
  const denominator = modelChanged ? undefined : modelWindow ?? inputBudget
  const percent = tokens !== undefined && denominator !== undefined ? tokens / denominator * 100 : undefined
  const reading = percent === undefined ? "—" : tokens !== 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`
  return { estimate, legacyReady, historical, modelChanged, modelWindow, inputBudget, measured, tokens, denominator, percent, reading, warning }
}
