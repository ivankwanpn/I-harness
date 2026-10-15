import type { PluginContext } from "@i-harness/core-plugin"
import { append, deriveMessages } from "@i-harness/core-session"
import { activeTokens, normalizeInputUsage } from "@i-harness/token-meter"
import type { AgentDeps, AgentResult, TurnLifecycle } from "./types.ts"
import type { AgentContext } from "./context.ts"
import type { ModelStep } from "./model-loop.ts"
import { acceptModelExchange } from "./exchange.ts"

type TurnFinalizationDeps = Pick<AgentDeps, "session" | "telemetry" | "flush">

export async function failTurn(deps: TurnFinalizationDeps, lifecycle: TurnLifecycle, error: unknown): Promise<never> {
  // Preparation hooks and context getters can refuse before the provider
  // stream opens. Close only this run's live boundaries; cold recovery and
  // tool outcomes remain owned by their existing paths.
  if (lifecycle.turnOpen) {
    try {
      if (lifecycle.stepOpen) {
        // An incomplete provider step must not replay partial tool calls.
        // A completed provider/tool result keeps its existing provenance.
        if (!lifecycle.providerCompleted && !lifecycle.stepFailed) append(deps.session, { type: "step/failed" })
        append(deps.session, { type: "step/end" })
      }
      append(deps.session, { type: "turn/end" })
      await deps.flush?.()
    } catch (cause) {
      const actionReason = error instanceof Error ? error.message : String(error)
      const savingReason = cause instanceof Error ? cause.message : String(cause)
      throw new AggregateError([error, cause], `${actionReason}; session saving failed: ${savingReason}`, { cause: error })
    }
  }
  throw error
}

/** Raw counters belong to every ended response, including capped/refused ones.
 * Reporting them does not accept that response as a context calibration. */
export function reportModelUsage(deps: Pick<AgentDeps, "telemetry">, { stepUsage }: Pick<ModelStep, "stepUsage">) {
  if (Object.keys(stepUsage).length > 0) {
    deps.telemetry?.emit({ type: "provider/usage", ts: Date.now(), data: { ...stepUsage } })
  }
  const normalized = normalizeInputUsage(stepUsage)
  const cacheRead = stepUsage.cacheReadTokens
  const measuredCacheRead = typeof cacheRead === "number" && Number.isSafeInteger(cacheRead) && cacheRead >= 0
  deps.telemetry?.emit({ type: "provider/cache", ts: Date.now(), data: {
    cacheReadReported: measuredCacheRead,
    ...(normalized ?? {}),
    ...(measuredCacheRead ? { cacheReadTokens: cacheRead } : {}),
  } })
}

export function completeModelStep(deps: Pick<AgentDeps, "session" | "telemetry">, context: Pick<AgentContext, "ownedBudget">, step: ModelStep, measurement: import("@i-harness/token-meter").PreparedRequestMeasurement, accepted?: import("@i-harness/core-session").ExchangeAcceptedEventV2) {
  const { stepUsage } = step
  reportModelUsage(deps, step)

  // Acceptance owns assistant/native persistence; this owner only reports usage
  // and calibrates the measured request that produced the completed response.
  // The caller has the accepted fact. A later Stop cannot revoke real usage.
  context.ownedBudget.record(measurement, stepUsage, accepted)

}

/** The accepted fact survives an uncertain flush or Stop; tool effects still
 * wait for the awaited acceptance owner to return successfully. */
export async function acceptCompletedModelStep(deps: TurnFinalizationDeps, context: Pick<AgentContext, "ownedBudget">, lifecycle: TurnLifecycle, step: ModelStep, measurement: import("@i-harness/token-meter").PreparedRequestMeasurement, signal?: AbortSignal, request?: import("@i-harness/core-session").AcceptedRequestAttributionV1): Promise<void> {
  let written: import("@i-harness/core-session").ExchangeAcceptedEvent | undefined
  let exactWritten: string | undefined
  try { await acceptModelExchange(deps, { identity: step.identity, step, signal, request, onAccepted(event) { written = event; exactWritten = JSON.stringify(event) } }) }
  finally {
    lifecycle.providerCompleted = !!written && deps.session.events[written.seq!] === written && JSON.stringify(written) === exactWritten
    if (lifecycle.providerCompleted) completeModelStep(deps, context, step, measurement, written?.type === "model/exchange-accepted" && written.version === 2 ? written : undefined)
    else reportModelUsage(deps, step)
  }
}

export function closeStep(deps: Pick<AgentDeps, "session" | "telemetry">, lifecycle: TurnLifecycle, getSteps: () => number, step: ModelStep) {
  const { stepText, toolCallsThisStep, truncatedThisStep, refusedThisStep } = step
  // M77: a REFUSED step still appends this message, and its text stays `""`.
  // The choice is deliberate and is the spec's (§1.3): the log must carry
  // SOMETHING for the step either way, and putting the semantics in the text
  // would make them unreadable to a program — "the model said nothing" and
  // "the model was blocked" would stay indistinguishable on the one surface
  // a reopen reads. The bit lives on `step/end.refused` below; the text is
  // the model's output and there was none.
  // M80: the THIRD ending, and the only one that carries no signal of its
  // own — a non-content success (HTTP 200, no answer text and no tool call,
  // a bare `end`: the ten non-content gemini stop reasons land here). Reported at
  // the step boundary, where both halves of the predicate are known. The
  // two bits above are EXCLUDED on purpose: a capped or refused step is
  // also text-less with no tool calls, and it already has its own, more
  // specific report — writing this one too would double-report it (M77
  // pinned that neither bit is the other's `else`, and the same discipline
  // holds on this side). A step whose only output was a tool call is NOT
  // empty: the call is content, and the loop continues on it.
  const emptyThisStep = stepText === "" && toolCallsThisStep === 0 && !truncatedThisStep && !refusedThisStep
  if (emptyThisStep) deps.telemetry?.emit({ type: "provider/empty", ts: Date.now(), data: { step: getSteps() } })

  append(deps.session, { type: "step/end", ...(truncatedThisStep ? { truncated: true } : {}), ...(refusedThisStep ? { refused: true } : {}), ...(emptyThisStep ? { empty: true } : {}) })
  lifecycle.stepOpen = false

  return emptyThisStep
}

export async function finishTurn(ctx: PluginContext, deps: TurnFinalizationDeps, lifecycle: TurnLifecycle, getSteps: () => number, reasoning: string[]): Promise<AgentResult> {
  append(deps.session, { type: "turn/end" })
  lifecycle.turnOpen = false
  // M25: turn/end + token/usage at the turn boundary. The token count is the
  // SAME estimate the M20 budget check uses (activeTokens over the derived
  // surface); guarded so an absent telemetry never pays for it.
  if (deps.telemetry) {
    deps.telemetry.emit({ type: "turn/end", ts: Date.now(), data: { turns: getSteps() } })
    deps.telemetry.emit({ type: "token/usage", ts: Date.now(), data: { tokens: activeTokens(deps.session) } })
  }
  // M14: content may be a parts array (image-bearing); extract text parts
  // only. The final message is an assistant text message, but be robust.
  const last = deriveMessages(deps.session).at(-1)
  const finalText = typeof last?.content === "string"
    ? last.content
    : Array.isArray(last?.content)
      ? last.content.filter((p) => p.type === "text").map((p) => p.text).join("")
      : ""
  // E5 "stop" hooks seam: emit at the turn boundary so hook handlers observe
  // the final text and can refuse it (a listener throw propagates as the
  // turn's failure). No handlers → emit returns the payload unchanged
  // (zero behavior change; additive event, no session-log write).
  await ctx.emit("agent/stop", { session: deps.session, turns: getSteps(), finalText })
  // Execution may already have external effects. A save failure is reported
  // separately and must never be presented as a successful durable turn.
  try { await deps.flush?.() }
  catch (cause) { throw new Error("Execution completed, but session saving failed", { cause }) }
  return { finalText, turns: getSteps(), reasoning }
}
