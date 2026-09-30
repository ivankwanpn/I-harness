import type { LLMMessage } from "@i-harness/llm-seam"

type ReviewMessage = Extract<LLMMessage, { role: "user" | "assistant" }> & { content: string }
interface Context { messages: ReviewMessage[]; busy: boolean }
export interface ReviewerContextLease {
  messages: ReviewMessage[]
  commit(prompt: string, response: string): void
  release(): void
}
export interface IsolatedReviewerPool {
  acquire(key: string): ReviewerContextLease | undefined
  clear(): void
}

/** Only neutral text is reused. A pool entry never stores tool calls, private
 * thinking, provider continuations or a decision that can skip a fresh review. */
export function createIsolatedReviewerPool(options: { maxContexts?: number; maxTurns?: number; maxContextChars?: number } = {}): IsolatedReviewerPool {
  const bound = (value: number | undefined, fallback: number, ceiling: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, ceiling) : fallback
  const maxContexts = bound(options.maxContexts, 8, 16)
  const maxTurns = bound(options.maxTurns, 4, 8)
  const maxChars = bound(options.maxContextChars, 16000, 32768)
  const contexts = new Map<string, Context>()
  return {
    acquire(key) {
      let context = contexts.get(key)
      // Concurrent reviews have separate transcripts. Waiting on a shared
      // context would couple one operation's cancellation to another's latency.
      if (context?.busy) return undefined
      if (!context && contexts.size >= maxContexts) {
        const oldest = [...contexts].find(([, candidate]) => !candidate.busy)
        if (!oldest) return undefined
        contexts.delete(oldest[0])
      }
      if (!context) { context = { messages: [], busy: false }; contexts.set(key, context) }
      contexts.delete(key); contexts.set(key, context)
      context.busy = true
      const entry = context
      let open = true
      return {
        messages: entry.messages.map((message) => ({ ...message })),
        commit(prompt, response) {
          if (!open) return
          const messages: ReviewMessage[] = [...entry.messages, { role: "user", content: prompt }, { role: "assistant", content: response }]
          while (messages.length > maxTurns * 2 || messages.reduce((sum, message) => sum + message.content.length, 0) > maxChars) messages.splice(0, 2)
          entry.messages = messages
        },
        release() { if (open) { open = false; entry.busy = false } },
      }
    },
    clear() { contexts.clear() },
  }
}
