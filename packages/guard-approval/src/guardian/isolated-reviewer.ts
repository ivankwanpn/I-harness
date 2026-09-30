import type { GuardianRequest } from "@i-harness/core-tools"
import { clampOutputCap } from "@i-harness/llm-seam"
import { parseGuardianAssessment, GUARDIAN_JSON_CONTRACT } from "./verdict.ts"
import { BUNDLED_GUARDIAN_POLICY, GUARDIAN_REVIEW_TIMEOUT_MS, renderGuardianMessage, renderRecentContext, type GuardianReviewDeps, type GuardianReviewVerdict } from "./reviewer.ts"

/** A dedicated no-tools model request. It owns no Agent, job or chat session. */
export async function runIsolatedGuardianReview(deps: GuardianReviewDeps, request: GuardianRequest): Promise<GuardianReviewVerdict> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("guardian review timed out")), deps.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS)
  const cancel = () => controller.abort(request.signal?.reason)
  request.signal?.addEventListener("abort", cancel, { once: true })
  if (request.signal?.aborted) cancel()
  let abortListener: (() => void) | undefined
  try {
    const work = async (): Promise<GuardianReviewVerdict> => {
      controller.signal.throwIfAborted()
      const args = typeof request.args === "string" ? request.args : JSON.stringify(request.args ?? null)
      if (args.length > 4000) throw new Error("Tool arguments exceed the reviewer request bound; require human approval")
      let model = deps.model ?? deps.parentModel
      let contextWindow = deps.model === undefined ? deps.contextWindow : undefined
      let maxOutputTokens = deps.model === undefined ? deps.maxOutputTokens : undefined
      let reasoningEffort: import("@i-harness/llm-seam").ReasoningEffort | undefined
      const selection = deps.roleSelectionFor?.("reviewer")
      if (selection && deps.model === undefined) {
        const allowed = typeof deps.allowSubagentModelSelection === "function" ? deps.allowSubagentModelSelection() : deps.allowSubagentModelSelection
        if (allowed !== true) throw new Error("Independent reviewer model is disabled")
        const resolved = await deps.resolveModel(selection)
        if (resolved.status !== "ready") throw new Error(resolved.reason)
        model = resolved.binding.client
        contextWindow = resolved.binding.contextWindow
        maxOutputTokens = resolved.binding.maxOutputTokens
        reasoningEffort = resolved.binding.reasoningEffort
      }
      controller.signal.throwIfAborted()
      const policy = deps.policyText ?? BUNDLED_GUARDIAN_POLICY
      const systemPrompt = `${policy}\n\n${GUARDIAN_JSON_CONTRACT}`
      const prompt = renderGuardianMessage(request, renderRecentContext(deps.parentSession), policy)
      const inputEstimate = Math.ceil((systemPrompt.length + prompt.length) / 4)
      if (contextWindow !== undefined && contextWindow <= inputEstimate) throw new Error("Reviewer context window is too small for the approval request")
      let text = ""
      for await (const event of model.stream({
        systemPrompt, messages: [{ role: "user", content: prompt }], tools: [],
        maxOutputTokens: clampOutputCap(Math.min(maxOutputTokens ?? 2048, 2048), contextWindow, inputEstimate),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), signal: controller.signal,
      })) {
        controller.signal.throwIfAborted()
        if (event.type === "text/chunk") {
          text += event.text
          if (text.length > 16384) throw new Error("Reviewer verdict exceeded its response bound")
        } else if (event.type === "error") throw event.error
        else if (event.type === "tool_call") throw new Error("The isolated reviewer attempted a tool call")
        else if (event.type === "end" && (event.truncated || event.refused)) return { outcome: "deny", rationale: "Reviewer did not produce a complete verdict", cause: "malformed" }
      }
      const verdict = parseGuardianAssessment(text)
      return verdict ? { outcome: verdict.outcome, rationale: verdict.rationale }
        : { outcome: "deny", rationale: "Reviewer produced malformed output", cause: "malformed" }
    }
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new Error("guardian aborted"))
      controller.signal.addEventListener("abort", abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    return await Promise.race([work(), aborted])
  } catch (error) {
    if (request.signal?.aborted) throw error
    return { outcome: "deny", rationale: error instanceof Error ? error.message : String(error), cause: controller.signal.aborted ? "timeout" : "operational" }
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener("abort", cancel)
    if (abortListener) controller.signal.removeEventListener("abort", abortListener)
  }
}
