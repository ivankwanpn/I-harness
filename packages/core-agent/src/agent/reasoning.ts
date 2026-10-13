import { append, publishTransient } from "@i-harness/core-session"
import type { LLMStreamEvent } from "@i-harness/llm-seam"

import type { AgentDeps } from "./types.ts"

export function createStepReasoning(deps: Pick<AgentDeps, "session">, reasoning: string[], abort: AbortSignal | undefined, startSeq: () => number) {
  let reasoningBlockIndex = 0
  let pendingReasoning: string[] = []
  let pendingReasoningBlockId: string | undefined
  let reasoningStreamId: string | undefined
  let reasoningAtSeq = 0
  let reasoningOffset = 0
  let reasoningDelta: string[] = []
  let reasoningTimer: ReturnType<typeof setTimeout> | undefined
  let reasoningPublishError: unknown
  const clearReasoningTimer = () => {
    if (reasoningTimer !== undefined) clearTimeout(reasoningTimer)
    reasoningTimer = undefined
  }
  const publishReasoning = () => {
    clearReasoningTimer()
    if (reasoningDelta.length === 0 || reasoningStreamId === undefined) return
    const text = reasoningDelta.join("")
    const offset = reasoningOffset
    reasoningDelta = []
    reasoningOffset += text.length
    publishTransient(deps.session, { type: "reasoning/chunk", streamId: reasoningStreamId, text, offset, atSeq: reasoningAtSeq, ...(pendingReasoningBlockId === undefined ? {} : { blockId: pendingReasoningBlockId }) })
  }
  const flushReasoning = () => {
    clearReasoningTimer()
    if (pendingReasoning.length === 0) return
    const event = { type: "reasoning" as const, text: pendingReasoning.join(""), streamId: reasoningStreamId!, ...(pendingReasoningBlockId === undefined ? {} : { blockId: pendingReasoningBlockId }) }
    pendingReasoning = []
    pendingReasoningBlockId = undefined
    reasoningStreamId = undefined
    reasoningDelta = []
    reasoningOffset = 0
    append(deps.session, event)
  }

  return {
    flush: flushReasoning,
    resetBlockIndex() { reasoningBlockIndex = 0 },
    checkPublication() { if (reasoningPublishError !== undefined) throw reasoningPublishError },
    accept(ev: Extract<LLMStreamEvent, { type: "reasoning" }>) {
      if (pendingReasoning.length > 0 && ev.blockId !== pendingReasoningBlockId) flushReasoning()
      reasoning.push(ev.text)
      if (ev.text) {
        if (reasoningStreamId === undefined) {
          reasoningStreamId = `${startSeq()}:${reasoningBlockIndex++}`
          reasoningAtSeq = deps.session.events.length
        }
        pendingReasoningBlockId = ev.blockId
        pendingReasoning.push(ev.text)
        reasoningDelta.push(ev.text)
        // First content appears immediately. Further deltas flush even
        // while the provider is awaiting its next token in this block.
        if (reasoningOffset === 0) publishReasoning()
        else if (reasoningTimer === undefined) reasoningTimer = setTimeout(() => {
          if (abort?.aborted) { clearReasoningTimer(); return }
          try { publishReasoning() }
          catch (error) { reasoningPublishError = error }
        }, 50)
      }
    },
  }
}
