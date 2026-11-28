import { bindVisibleToolIds, deepSeekCallFingerprint, hasTextAfterTool, hasReorderedTools, isOfficialDeepSeekApi, officialXaiRoute, type LLMStreamEvent, type ProviderBlockOrderEntry } from "@i-harness/llm-seam"
import { projectionFingerprint } from "@i-harness/token-meter"
import { isDeepStrictEqual } from "node:util"
import type { OpenAIConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"
import { createResponsesReasoning } from "./reasoning.ts"
import { responsesEndpointFingerprint } from "@i-harness/llm-seam"
import { createResponseText } from "./text.ts"

/** One response owns all terminal, continuation, and partial function-call state. */
export function createResponseFold(config: Pick<OpenAIConfig, "model" | "providerId" | "baseUrl">, codexSubscription: boolean, onToolArguments: () => void, endpoint: string) {
  const xai = codexSubscription ? undefined : officialXaiRoute(config.baseUrl)
  const deepSeekCalls: string[] | undefined = !codexSubscription && config.providerId && isOfficialDeepSeekApi(config.baseUrl) ? [] : undefined
  let terminal: 'completed' | 'incomplete' | 'done' | 'failed' | undefined
  // M72 Ⅱ: the Responses wire's own truncation literal lives in
  // `response.incomplete.incomplete_details.reason` — set in `handleEvent`
  // below, read once at the ending. Absent stays absent: only `true` writes
  // the field.
  let truncated = false
  // M77: the SAME field carries this wire's refusal literal,
  // `content_filter`. Before M77 that reason was recognised by nothing: the
  // stream ended HTTP 200 with no content, the seam reported an empty
  // SUCCESS, and core-agent logged an empty assistant message for a turn
  // the model had actually refused. Two variables rather than one: a
  // response can be both truncated and refused, so neither bit may be
  // produced as the other's `else`. Only `true` is ever written.
  let refused = false
  let routeFingerprint: string | null | undefined
  const replayEndpoint = () => {
    if (routeFingerprint === undefined) routeFingerprint = responsesEndpointFingerprint(endpoint, codexSubscription)
    return routeFingerprint
  }
  const reasoning = createResponsesReasoning(Boolean(xai), !codexSubscription && isOfficialDeepSeekApi(config.baseUrl), () => replayEndpoint() !== null)
  const reasoningItems = reasoning.items
  const outputItems = new Map<number, ProviderBlockOrderEntry>()
  let outputOrderValid = true
  let hasAssistantPhase = false
  const emittedCalls: { id?: string }[] = []
  const text = createResponseText()
  const recordOutput = (index: unknown, entry: ProviderBlockOrderEntry): void => {
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || outputItems.has(index)) { outputOrderValid = false; return }
    outputItems.set(index, entry)
  }
  type FunctionItem = { id?: string; name?: string; call_id?: string; namespace?: string; arguments?: unknown; status?: unknown }
  type Call = { itemId?: string; callId?: string; outputIndex?: number; name?: string; buffer: string; finalArgs?: string }
  const calls = new Set<Call>(), callKeys = new Map<string, Call>()
  let toolError: string | undefined
  const recordCall = (outputIndex: unknown, id: string | undefined, name: string, args: unknown): LLMStreamEvent => {
    const call = { ...(id ? { id } : {}), name, args }
    deepSeekCalls?.push(deepSeekCallFingerprint(call))
    recordOutput(outputIndex, { kind: "tool", index: emittedCalls.length })
    emittedCalls.push(id ? { id } : {})
    return { type: "tool_call", call }
  }
  // The same logical call can finish in an arguments event, an item snapshot,
  // and the completed response. Match each supplied identity to the same slot.
  const invalidIdentity = (value: unknown) => value !== undefined && (typeof value !== "string" || !value.trim())
  const track = (item: FunctionItem, index: unknown): Call | undefined => {
    if (toolError) return
    if (invalidIdentity(item.id) || invalidIdentity(item.call_id) || invalidIdentity(item.name)) {
      toolError = "OpenAI response contains an invalid function_call identity"
      return
    }
    if (index !== undefined && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)) {
      toolError = "OpenAI response contains an invalid function_call output index"
      return
    }
    if (codexSubscription && item.namespace !== undefined && item.namespace !== "ih") {
      toolError = "Codex subscription returned an undeclared tool namespace"
      return
    }
    const position = typeof index === "number" ? index : undefined
    const block = position === undefined ? undefined : outputItems.get(position)
    if (block && block.kind !== "tool") { toolError = "OpenAI response changed an output item's type"; return }
    const byId = item.id ? callKeys.get("item:" + item.id) : undefined
    if (byId && item.call_id === undefined && item.name === undefined && (position === undefined || byId.outputIndex === position)) return byId
    const keys: string[] = []
    if (item.id) keys.push("item:" + item.id)
    if (item.call_id) keys.push("call:" + item.call_id)
    if (position !== undefined) keys.push("index:" + position)
    const matches = keys.map(key => callKeys.get(key)).filter((call): call is Call => call !== undefined)
    const call: Call = matches[0] ?? { buffer: "" }
    if (matches.some(match => match !== call)
      || (call.itemId && item.id && call.itemId !== item.id)
      || (item.call_id && (call.callId !== undefined || call.finalArgs !== undefined) && call.callId !== item.call_id)
      || (call.name && item.name && call.name !== item.name)
      || (call.outputIndex !== undefined && position !== undefined && call.outputIndex !== position)) {
      toolError = "OpenAI response contains conflicting function_call identities"
      return
    }
    if (item.id) call.itemId = item.id
    if (item.call_id) call.callId = item.call_id
    if (item.name) call.name = item.name
    if (position !== undefined) call.outputIndex = position
    for (const key of keys) callKeys.set(key, call)
    calls.add(call)
    return call
  }
  const completeCall = (call: Call, serialized: unknown, malformed: string | undefined): LLMStreamEvent[] => {
    if (typeof serialized !== "string" || !call.name) { toolError = malformed; return [] }
    if (call.finalArgs === serialized) return []
    try {
      const args: unknown = JSON.parse(serialized)
      if (call.finalArgs !== undefined) {
        if (!isDeepStrictEqual(JSON.parse(call.finalArgs), args)) toolError = "OpenAI response changed completed function_call arguments"
        return []
      }
      call.finalArgs = serialized
      call.buffer = ""
      return [recordCall(call.outputIndex, call.callId, call.name, args)]
    } catch { toolError = malformed; return [] }
  }
  const recordMessage = (position: unknown, item: Record<string, unknown>) => {
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) { outputOrderValid = false; return }
    if (!Array.isArray(item.content) || item.content.some(part => part?.type !== "output_text" || typeof part.text !== "string")) {
      outputOrderValid = false
      return
    }
    const previous = outputItems.get(position)
    if ((previous && previous.kind !== "text") || callKeys.has("index:" + position)) {
      toolError = "OpenAI response changed an output item's type"
      return
    }
    const phase = typeof item.phase === "string" || item.phase === null ? item.phase : previous?.phase
    if (previous?.phase !== undefined && previous.phase !== phase) {
      toolError = "OpenAI response changed an assistant message phase"
      return
    }
    if (phase !== undefined) hasAssistantPhase = true
    outputItems.set(position, { kind: "text", text: item.content.map(part => part.text).join(""), ...(phase !== undefined ? { phase } : {}) })
  }
  const replayableSnapshotItem = (item: Record<string, unknown>, index: number): boolean => {
    if (item.type === "function_call") return true
    if (item.type === "message") return item.role === "assistant" && Array.isArray(item.content) &&
      item.content.every(part => part?.type === "output_text" && typeof part.text === "string")
    return item.type === "reasoning" && reasoning.matches(index, item)
  }
  // M77 (fix wave): the Responses wire's OTHER refusal shape — a refusal
  // CONTENT PART (`ResponseOutputRefusal`, `{ type: "refusal", refusal:
  // string }`) rather than a stop reason, so `response.incomplete` never
  // fires and the stream ends `response.completed` with no text at all.
  // Three carriers are read, because at this layer none implies another:
  // the part's own events (`response.refusal.delta`/`.done`), the part
  // under `part` (`response.content_part.added`/`.done`) and the part in a
  // finished item's `content` (`response.output_item.added`/`.done` — the
  // same inline-item shape the function-call arm below already guards for).
  // The check keys on the part's `type`, never on a part being present:
  // EVERY streamed part arrives through these events, `output_text`
  // included, so "a part is here" would mark every ordinary turn refused.
  // The refusal's TEXT is deliberately NOT promoted into assistant text (a
  // parked product decision); only the bit is set.
  const refusalParts = (parts: unknown): boolean =>
    Array.isArray(parts) && parts.some((p) => (p as { type?: string } | undefined)?.type === "refusal")
  const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
    const t = event.type as string
    if (
      t === "response.refusal.delta" ||
      t === "response.refusal.done" ||
      (event.part as { type?: string } | undefined)?.type === "refusal" ||
      refusalParts((event.item as { content?: unknown } | undefined)?.content)
    ) {
      refused = true
    }
    if (t === "response.output_text.delta") return text.delta(event)
    if (t === "response.output_text.done" || t === "response.content_part.done") return text.partDone(event)
    if (t === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type !== "function_call" && callKeys.has("index:" + event.output_index)) toolError = "OpenAI response changed a function_call item's type"
      if (item?.type === "reasoning") {
        const index = reasoning.observe(item, event.output_index, outputItems.has(event.output_index as number) || callKeys.has("index:" + event.output_index))
        if (typeof index === "number") recordOutput(event.output_index, { kind: "reasoning", index })
        else if (index !== "repeat") outputOrderValid = false
      } else if (item?.type === "message" && item.role === "assistant") {
        recordMessage(event.output_index, item)
        return text.message(event.output_index, item)
      } else if (item?.type === "function_call") {
        const call = track(item, event.output_index)
        if (call && (item.status === undefined || item.status === "completed")) {
          if (item.arguments !== undefined && typeof item.arguments !== "string") { toolError = "openai malformed function_call arguments"; return [] }
          if (!call.callId && call.finalArgs === undefined) return []
          // A provider may omit the final arguments here and supply them in
          // response.output. An incomplete buffer remains pending until then.
          return completeCall(call, item.arguments === undefined ? call.finalArgs ?? call.buffer : item.arguments,
            item.arguments === undefined ? undefined : "openai malformed function_call arguments")
        }
        if (call) toolError = "OpenAI response contains an unfinished function_call item"
      } else if (item !== undefined) outputOrderValid = false
      return []
    }
    if (t === "response.output_item.added") {
      const item = event.item as FunctionItem & { type: string }
      if (item?.type === "function_call") {
        const call = track(item, event.output_index)
        if (!call || item.arguments === undefined || typeof item.arguments === "string" && !item.arguments.trim()) return []
        if (item.status === "in_progress" && typeof item.arguments === "string") call.buffer ||= item.arguments
        else if (item.status === undefined || item.status === "completed") return completeCall(call, item.arguments, "openai malformed inline function_call arguments")
      }
      return []
    }
    if (t === "response.function_call_arguments.delta") {
      const ev = event as { item_id: string; delta: string }
      const call = track({ id: ev.item_id }, event.output_index)
      if (call && call.finalArgs === undefined && typeof ev.delta === "string" && ev.delta.length > 0) { call.buffer += ev.delta; onToolArguments() }
      return []
    }
    if (t === "response.function_call_arguments.done") {
      const ev = event as { item_id: string; name?: string; arguments?: unknown }
      const call = track({ id: ev.item_id, name: ev.name }, event.output_index)
      return call ? completeCall(call, ev.arguments === undefined ? call.finalArgs ?? call.buffer : ev.arguments,
        ev.arguments === undefined ? undefined : "openai malformed function_call arguments") : []
    }
    if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined
      const index = t === "response.reasoning_summary_text.delta" ? event.summary_index : event.content_index
      const blockId = itemId === undefined ? undefined : `${itemId}:${t === "response.reasoning_text.delta" ? "text:" : ""}${typeof index === "number" ? index : 0}`
      return [{ type: "reasoning", ...(blockId === undefined ? {} : { blockId }), text: typeof event.delta === "string" ? event.delta : "" }]
    }
    // M72 Ⅱ: the Responses stream's truncation ending. `response.incomplete`
    // also fires for `content_filter` — a REFUSAL, not a truncation — so the
    // bit keys on the REASON, never on the event name. M77: the refusal
    // reason now sets its own bit, the sibling of the truncation above.
    if (t === "response.incomplete") {
      terminal = 'incomplete'
      const reason = (event.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details?.reason
      const usage = mapUsage((event.response as { usage?: unknown } | undefined)?.usage)
      const events: LLMStreamEvent[] = usage ? [{ type: "usage", usage }] : []
      if (codexSubscription) return [...events, { type: "error", error: new Error(`Codex subscription response incomplete: ${reason ?? "unknown reason"}`) }]
      if (reason === "max_output_tokens") truncated = true
      if (reason === "content_filter") refused = true
      const output = (event.response as { output?: unknown } | undefined)?.output
      if (truncated && !refused && Array.isArray(output)) {
        const suffixes = text.terminal(output)
        for (const [index, item] of output.entries()) {
          if (item?.type === "message" && item.role === "assistant") recordMessage(index, item)
        }
        if (!text.error) for (const suffix of suffixes.values()) events.push({ type: "text/chunk", text: suffix })
      } else if (truncated && !refused && output === undefined) events.push(...text.drain())
      if (!truncated && !refused) events.push({ type: "error", error: new Error("OpenAI response was incomplete") })
      return events
    }
    if (t === "response.completed") {
      terminal = 'completed'
      const response = event.response as { usage?: unknown; output?: unknown; status?: unknown } | undefined
      const usage = mapUsage(response?.usage)
      const events: LLMStreamEvent[] = usage ? [{ type: "usage", usage }] : []
      if (response?.status !== undefined && response.status !== "completed") toolError = "OpenAI response did not complete"
      if (response?.output !== undefined && !Array.isArray(response.output)) toolError = "OpenAI response has an invalid output snapshot"
      if (Array.isArray(response?.output)) {
        if (response.output.some(item => item?.type === "message" && refusalParts(item.content))) refused = true
        if (refused) return events
        if (!toolError) reasoning.terminal(response.output, index => outputItems.has(index) || callKeys.has("index:" + index),
          (index, ordinal) => recordOutput(index, { kind: "reasoning", index: ordinal }))
        const finalCalls = new Set<Call>(), recovered: LLMStreamEvent[] = []
        const suffixes = text.terminal(response.output)
        let recoveredTool = false
        for (const [index, item] of response.output.entries()) {
          if (item === null || typeof item !== "object" || typeof item.type !== "string") { toolError = "OpenAI response has an invalid output item"; break }
          if (item.type === "message" && item.role === "assistant") {
            if (item.status !== undefined && item.status !== "completed") {
              toolError = "OpenAI completed response contains an unfinished assistant message"
              break
            }
            recordMessage(index, item)
            const suffix = suffixes.get(index)
            if (suffix) recovered.push({ type: "text/chunk", text: suffix })
          }
          if (item?.type !== "function_call") continue
          const call = track(item, index)
          if (!call) break
          if (finalCalls.has(call) || item.status !== undefined && item.status !== "completed") { toolError = "OpenAI response has an invalid final function_call"; break }
          if (!call.callId && call.finalArgs === undefined) { toolError = "OpenAI final function_call is missing its call_id"; break }
          finalCalls.add(call)
          const newCalls = completeCall(call, item.arguments === undefined ? call.finalArgs : item.arguments, "openai malformed function_call arguments")
          if (newCalls.length) recoveredTool = true
          recovered.push(...newCalls)
        }
        if (!toolError && finalCalls.size !== calls.size) toolError = "OpenAI response omitted an announced function_call"
        if (recoveredTool && !toolError && !response.output.every(replayableSnapshotItem)) {
          toolError = "OpenAI final function_call snapshot contains unconfirmed assistant content"
        }
        if (!toolError && !text.error) events.push(...recovered)
      } else if (response?.output === undefined && !toolError && !refused) events.push(...text.drain())
      return events
    }
    // M72 Ⅰ: the Responses API signals failure on the stream (`response.failed`)
    // and can also send a bare `error` event. Both used to fall through to the
    // empty default, so a failed response was indistinguishable from an empty
    // one. `response.incomplete` is NOT handled here and is NOT a failure:
    // it has its own arm above, which now carries BOTH bits (M72 Ⅱ's
    // truncation bit and M77's refusal bit), and M77's content-part refusal
    // is read at the top of this handler — so no refusal shape lands in this
    // arm.
    //
    // The two shapes carry their fields differently, so this arm reads both:
    // `response.failed` nests them under `response.error.{code,message}`,
    // while the canonical bare `error` event is FLAT on the wire —
    // `{type:"error",code,message,param,sequence_number}` — with an older
    // nested `error.message` still seen in the wild (tracked as a fallback).
    // Retain the structured identity separately: provider message wording
    // cannot determine whether a failure is transient or terminal.
    if (t === "response.failed" || t === "error") {
      terminal = 'failed'
      const r = event.response as { error?: { message?: string; code?: string } } | undefined
      const flat = event as { code?: unknown; message?: unknown }
      const nested = event.error as { code?: unknown; message?: string } | undefined
      const code = r?.error?.code ?? flat.code ?? nested?.code
      const text = r?.error?.message ?? (typeof flat.message === "string" ? flat.message : undefined) ?? nested?.message ?? "the provider reported a failed response"
      const usage = t === "response.failed" ? mapUsage((event.response as { usage?: unknown } | undefined)?.usage) : undefined
      const events: LLMStreamEvent[] = usage ? [{ type: "usage", usage }] : []
      events.push({ type: "error", error: Object.assign(new Error(typeof code === "string" ? `${code}: ${text}` : text), typeof code === "string" ? { code } : {}) })
      return events
    }
    return []
  }
  const finish = (): LLMStreamEvent => {
    if (!truncated && !refused && text.error) return { type: "error", error: Object.assign(new Error(text.error), { code: "MALFORMED_RESPONSE" }) }
    if (!truncated && !refused && toolError) return { type: "error", error: new Error(toolError) }
    if (codexSubscription && terminal !== 'completed') {
      return { type: "error", error: new Error("Codex subscription stream ended without response.completed") }
    }
    // A-01: a normal Responses stream terminates with response.completed (some
    // compatible endpoints use the Chat-Completions [DONE] sentinel instead).
    // EOF without either is a dropped connection, not a completed turn; before
    // this check it was reported as an empty success.
    if (!terminal) {
      return { type: "error", error: new Error("OpenAI stream ended without response.completed") }
    }
    if (!truncated && !refused && [...calls].some(call => call.finalArgs === undefined)) {
      return { type: "error", error: new Error("OpenAI response closed with an unfinished function_call") }
    }
    // M77: the two bits are independent — each is written on its own, so a
    // response that was both truncated and refused carries both. Both absent
    // ⇒ the byte-exact `{ type: "end" }` every clean ending returned before.
    const indexedOutput = [...outputItems.entries()].sort(([a], [b]) => a - b)
    const indexedOrder = outputOrderValid && indexedOutput.length > 0 && indexedOutput.every(([index], position) => index === position)
      ? indexedOutput.map(([, entry]) => entry) : undefined
    const outputOrder = indexedOrder && (reasoningItems.size > 0 || hasAssistantPhase || hasTextAfterTool(indexedOrder) || hasReorderedTools(indexedOrder)) ? bindVisibleToolIds(indexedOrder, emittedCalls) : undefined
    const deepSeekReplayFingerprint = deepSeekCalls && outputOrder && reasoningItems.size > 0
      ? projectionFingerprint([outputOrder.map(entry => entry.kind === "text" ? entry.text : "").join(""), deepSeekCalls])
      : undefined
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(reasoningItems.size || outputOrder ? { providerContinuation: { kind: "openai-responses", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), ...(xai ? { origin: xai.origin } : {}), reasoningItems: [...reasoningItems.values()], ...(outputOrder ? { outputOrder } : {}), ...(deepSeekReplayFingerprint ? { deepSeekReplayFingerprint } : {}), ...(reasoningItems.size ? { replayEndpointFingerprint: replayEndpoint() } : {}) } as const } : {}) }
  }
  return { handleEvent, finish, done() {
    terminal = 'done'
    return codexSubscription || refused || toolError ? [] : text.drain()
  }, get terminal() { return terminal !== undefined } }
}
