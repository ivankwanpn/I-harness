import { readSummaryStream, type SummaryStreamResult } from "./summary/stream.ts"
import { buildSummaryPrompt } from "./summary/prompt.ts"
import { inspectCheckpoint } from "./summary/checkpoint.ts"
import { prepareSummary, type SummaryLimits } from "./prepared-summary.ts"
import { SummaryBlockedError, SummaryCheckpointError } from "./summary-errors.ts"
import { modelFailureFacts } from "@i-harness/llm-seam"
import type { LLMMessage, LLMRequest, ModelClient, ToolSchema } from "@i-harness/llm-seam"
import { deriveMessages, type SessionView as Session } from "@i-harness/core-session"
import { sliceMessages } from "./slices.ts"

function confirmedOverflow(error: unknown): boolean {
  if (error instanceof AggregateError) return false
  if (modelFailureFacts(error)?.code !== "CONTEXT_WINDOW_EXCEEDED") return false
  let current = error
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const record = current as { code?: string; modelFailure?: { code?: string }; cause?: unknown }
    if (record.code === "CONTEXT_WINDOW_EXCEEDED" || record.modelFailure?.code === "CONTEXT_WINDOW_EXCEEDED") return true
    current = record.cause
  }
  return false
}

function textOf(messages: LLMMessage[]) { return messages.map(message => {
  const content = typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : `[image: ${part.image.mediaType}, ${Math.ceil(part.image.dataBase64.length * 3 / 4)} bytes]`).join("\n")
  const calls = message.role === "assistant" ? (message.toolCalls ?? []).map(call => `tool ${call.name} (${call.id}): ${JSON.stringify(call.args)}`).join("\n") : ""
  return `[${message.role}]\n${content}${calls ? `\n${calls}` : ""}`
}).join("\n")
}

/** Independent prepared summary admission. Stream invocations share one bound;
 * hidden transport retries remain outside this transaction-local count. */
export async function summarizeWithModel(
  model: ModelClient, replayText: string, maxTokens: number,
  previousSummary?: string, instructions?: string, minSummaryChars = 500,
  attemptsTracker?: { count: number },
  prefix?: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] },
  limits: SummaryLimits = {}, region?: { session: Session; shadowedSeqs: number[] },
): Promise<{ text: string; attempts: number }> {
  if (maxTokens * 4 < minSummaryChars) throw new SummaryBlockedError("retention-policy", { chars: maxTokens * 4, floor: minSummaryChars })
  const maximum = limits.maxSummaryCalls ?? 8
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) throw new SummaryBlockedError("call-policy")
  const tracker = attemptsTracker ?? { count: 0 }
  let attempts = 0, running = previousSummary
  const check = () => { limits.signal?.throwIfAborted(); limits.validateBeforeTransport?.() }
  // Distinct summary bindings receive a text projection. Preserve semantic
  // tool work and image descriptors without replaying another model's signed
  // continuation, signatures or base64 payload as ordinary user text.
  type Piece = { messages: LLMMessage[]; text: string; shrinks: number; standalone?: true; rejectedTokens?: number }
  let whole = prefix?.messages ?? []
  if (!prefix && region) {
    // Distinct text splits must incorporate the same selected events/anchor
    // that the commit will replace, never a broader historical prefix. Keep
    // invisible substitutions and admissions needed to materialize their data.
    const selected = new Set(region.shadowedSeqs)
    try { whole = deriveMessages({ ...region.session, events: region.session.events.filter(event =>
      event.type === "compaction/prune" || event.type === "agent/input/admitted" || event.seq !== undefined && selected.has(event.seq)) }) }
    catch { whole = [{ role: "user", content: replayText }] } // malformed legacy images remain descriptor text
  }
  const pending: Piece[] = [{ messages: whole, text: replayText, shrinks: 0 }]
  let lastLength = 0, lastFailure: "retention-output" | "checkpoint-format" = "retention-output"
  while (pending.length) {
    const piece = pending[0]!
    let accepted = false
    for (let qualityRound = 0; qualityRound < 2; qualityRound++) {
      check()
      const directive = buildSummaryPrompt(piece.text, running, instructions, { embedText: prefix === undefined })
        + `\nRetained checkpoint must be between ${minSummaryChars} and ${maxTokens * 4} characters. Preserve the objective, authority, instructions and completed outcomes within that limit.`
        + (qualityRound ? "\nThe previous output did not meet the checkpoint contract. Produce all seven sections and exact framing, with nonempty content, within the stated minimum and maximum retained bounds." : "")
      // A later autonomous tool round can be summarized independently once all
      // preceding calls have results. Keep its native assistant/result payload
      // intact and open a legal standalone conversation. The rolling checkpoint
      // in directive carries the original task/authority from preceding pieces.
      const opener: LLMMessage[] = prefix && piece.standalone && piece.messages[0]?.role === "assistant"
        ? [{ role: "user", content: "Summarize the following recorded conversation continuation. Preserve its completed outcomes under the task and authority in the checkpoint." }] : []
      const request: LLMRequest = { systemPrompt: prefix?.systemPrompt ?? "", tools: prefix?.tools ?? [],
        messages: [...opener, ...(prefix ? piece.messages : []), { role: "user", content: directive }], promptCache: { mode: "off" },
        ...(limits.reasoningEffort !== undefined ? { reasoningEffort: limits.reasoningEffort } : {}), ...(limits.signal ? { signal: limits.signal } : {}) }
      const { candidate, inputTokens, room, requiredRoom, facts } = await prepareSummary(model, request, maxTokens, limits, check)
      // Compare final candidates on both sides of reduction.
      const reduced = piece.rejectedTokens === undefined || inputTokens < piece.rejectedTokens
      if (!reduced || room !== undefined && room < requiredRoom) {
        const segments = sliceMessages(piece.messages, 1, true)
        if (!reduced || segments.length < 2) throw new SummaryBlockedError("fixed-input", { input: inputTokens, output: requiredRoom, window: limits.contextWindow })
        const split = Math.ceil(segments.length / 2)
        const chunks = [segments.slice(0, split).flat(), segments.slice(split).flat()]
        pending.splice(0, 1, ...chunks.map(messages => ({ messages, text: textOf(messages), shrinks: piece.shrinks, standalone: true as const, rejectedTokens: inputTokens })))
        accepted = true // resliced; no work consumed and no transport made
        break
      }
      limits.onMeasurement?.(facts)
      if (tracker.count >= maximum) throw new SummaryBlockedError("call-limit", { limit: maximum })
      if (limits.beforeTransport) {
        try { await limits.beforeTransport() } catch (error) { throw new SummaryCheckpointError(error) }
      }
      check()
      attempts++; tracker.count++
      let result: SummaryStreamResult
      try {
        result = await readSummaryStream(candidate, { ...limits, validateBeforeTransport: check, maxRetainedChars: maxTokens * 4 })
      } catch (error) {
        if (limits.signal?.aborted || !confirmedOverflow(error)) throw error
        check()
        if (piece.shrinks >= 2) throw new SummaryBlockedError("shrink-limit")
        const segments = sliceMessages(piece.messages, 1, true)
        if (segments.length < 2) throw new SummaryBlockedError("fixed-input", { input: inputTokens, output: requiredRoom, window: limits.contextWindow })
        const split = Math.ceil(segments.length / 2)
        pending.splice(0, 1, ...[segments.slice(0, split).flat(), segments.slice(split).flat()].map(messages => ({ messages, text: textOf(messages), shrinks: piece.shrinks + 1, standalone: true as const, rejectedTokens: inputTokens })))
        accepted = true
        break
      }
      check()
      if (!result.chars) throw new Error('compaction: summarizer returned empty output')
      lastLength = result.chars
      if (result.overflow || result.chars < minSummaryChars || result.chars > maxTokens * 4) { lastFailure = 'retention-output'; continue }
      const parsed = inspectCheckpoint(result.text)
      if (parsed.kind !== 'complete') { lastFailure = 'checkpoint-format'; continue }
      if (result.observation) limits.onPieceAccepted?.(result.observation)
      running = parsed.text; pending.shift(); accepted = true; break
    }
    if (!accepted) throw new SummaryBlockedError(lastFailure, { chars: lastLength, floor: minSummaryChars, limit: maxTokens * 4 })
  }
  check()
  if (running === undefined || inspectCheckpoint(running).kind !== "complete" || running.length < minSummaryChars || running.length > maxTokens * 4) throw new Error("compaction: final retained checkpoint is invalid")
  return { text: running, attempts }
}
