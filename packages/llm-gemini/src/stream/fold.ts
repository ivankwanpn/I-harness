import { reportStreamActivity, stringifyJsonData, type LLMRequest, type LLMStreamEvent, type ProviderBlockOrderEntry } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"

/**
 * M77 (fix wave): the candidate-side FinishReason values whose documented
 * meaning is "generation stopped because the content was blocked". The vendor's
 * enum (ai.google.dev/api/generate-content, FinishReason) says, verbatim:
 * `SAFETY` "The response candidate content was flagged for safety reasons.",
 * `RECITATION` "…flagged for recitation reasons.", `BLOCKLIST` "Token
 * generation stopped because the content contains forbidden terms.",
 * `PROHIBITED_CONTENT` "Token generation stopped for potentially containing
 * prohibited content.", `SPII` "Token generation stopped because the content
 * potentially contains Sensitive Personally Identifiable Information (SPII).",
 * `IMAGE_SAFETY` "Token generation stopped because generated images contain
 * safety violations.", `IMAGE_PROHIBITED_CONTENT` "Image generation stopped
 * because generated images has other prohibited content.", `IMAGE_RECITATION`
 * "Image generation stopped due to recitation."
 *
 * Every one of them reaches the client the same way — HTTP 200 with no content —
 * so each reads as an empty SUCCESS without this set. The REST of the enum is
 * deliberately absent: `STOP`/`MAX_TOKENS` are the clean ending and the cap,
 * and `LANGUAGE`, `OTHER`, `NO_IMAGE`, `IMAGE_OTHER`, `MALFORMED_RESPONSE`,
 * `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`,
 * `ESCALATION` and `PUP_LIMITED_DISABLED` do not say the content was blocked
 * (the last two are request/account-level), so claiming a refusal for them
 * would be a false statement about what the model did.
 */
const CONTENT_BLOCK_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
])

/** Own one successful response's mutable Gemini parts, tools and finish flags.
 * Config/request references remain live for activity and terminal identity. */
export function createGeminiFold(request: LLMRequest, config: GeminiConfig) {
  // M72 Ⅱ: the wire's own truncation literal (`finishReason: "MAX_TOKENS"`)
  // — set in `handleChunk` below, read once at the ending. Absent stays
  // absent: only `true` writes the field.
  let truncated = false
  // M77: this wire has TWO refusal carriers and neither was read: a
  // candidate's `finishReason` of `SAFETY` or `RECITATION` (the model's
  // own answer was blocked), and `promptFeedback.blockReason` on the chunk
  // (the REQUEST was blocked — there `candidates` may be absent entirely,
  // so the candidate read below cannot see it at all). A separate variable
  // from `truncated`: the two are independent and neither is the other's
  // `else`. Only `true` is ever written.
  let refused = false
  // Function-call accumulation (Gemini streams a functionCall as several
  // chunks: the first carries the name, the rest carry args objects that
  // may be partial — the docs' canonical accumulation is to store the
  // name and accumulate the args pieces). Emitted just before `end`.
  // Delimiters: a chunk carrying a name ALWAYS starts a new pending call
  // (two parallel calls of the same function are distinct calls); args-only
  // chunks continue the LAST pending call.
  interface PendingCall {
    id?: string
    name: string
    argsJson: string
    rawArgs: Record<string, unknown>[]
    signature?: string
  }
  const pendingCalls: PendingCall[] = []
  const callSignatures: (string | null)[] = []
  const callBindings: { id?: string; name: string; argsJson: string }[] = []
  const thoughtParts: { text: string; thoughtSignature?: string }[] = []
  let activeThought: { index: number; part: { text: string; thoughtSignature?: string } } | undefined
  const partOrder: ProviderBlockOrderEntry[] = []
  let activeText: { index: number; part: Extract<ProviderBlockOrderEntry, { kind: "text" }> } | undefined
  let textSignature: string | undefined
  const emptyTextSignatures: string[] = []
  const accumulateArgs = (call: PendingCall, args: unknown): void => {
    if (typeof args === "object" && args !== null) {
      if (Object.keys(args).length > 0) reportStreamActivity(request, "tool-arguments")
      call.rawArgs.push(args as Record<string, unknown>)
      call.argsJson += stringifyJsonData(args)!
    }
  }
  const handleFunctionCall = (fc: { id?: string; name?: string; args?: unknown }, signature?: string): void => {
    if (fc.name !== undefined) {
      // A name always opens a new call — never fold into an existing
      // same-name pending call (parallel calls would lose their args).
      const call: PendingCall = { name: fc.name, argsJson: "", rawArgs: [], ...(fc.id ? { id: fc.id } : {}), ...(signature ? { signature } : {}) }
      pendingCalls.push(call)
      if (fc.args !== undefined) accumulateArgs(call, fc.args)
    } else if (fc.args !== undefined) {
      const call = pendingCalls[pendingCalls.length - 1]
      if (call !== undefined) { accumulateArgs(call, fc.args); if (fc.id) call.id = fc.id; if (signature) call.signature = signature }
    }
  }
  const finalizeCalls = function* (): Generator<LLMStreamEvent, boolean, unknown> {
    for (const call of pendingCalls) {
      callSignatures.push(call.signature ?? null)
      let args: unknown = {}
      try {
        args = JSON.parse(call.argsJson === "" ? "{}" : call.argsJson) as unknown
      } catch {
        // The chunks are separate JSON objects (not fragments of one
        // document), so a concat parse fails for partial-args pieces —
        // merge the pieces (docs' spread accumulation).
        args = call.rawArgs.length > 0 ? Object.assign({}, ...call.rawArgs) : {}
      }
      callBindings.push({ ...(call.id ? { id: call.id } : {}), name: call.name, argsJson: stringifyJsonData(args)! })
      if (yield { type: "tool_call", call: { ...(call.id ? { id: call.id } : {}), name: call.name, args } }) return true
    }
    pendingCalls.length = 0
    return false
  }
  const handleChunk = (event: Record<string, unknown>): LLMStreamEvent[] => {
    const events: LLMStreamEvent[] = []
    const candidates = event.candidates as { content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown } }[] } }[] | undefined
    const finishReason = (candidates?.[0] as { finishReason?: string } | undefined)?.finishReason
    if (finishReason === "MAX_TOKENS") truncated = true
    // M77 (fix wave): the candidate-side carrier, over the WHOLE set of
    // content-block reasons the vendor's enum documents (see
    // CONTENT_BLOCK_FINISH_REASONS above). The comment this replaces said
    // "the two content refusals … every other reason writes nothing", which
    // the enum contradicts: PROHIBITED_CONTENT, BLOCKLIST, SPII,
    // IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT and IMAGE_RECITATION are the
    // same kind of stop, with the same HTTP 200 and the same empty content.
    // `MAX_TOKENS` above is the truncation bit, and `STOP` is pinned as a
    // clean ending by the M72 Ⅱ control test in this package; a reason not
    // in the set writes NOTHING at all — absent stays absent, never `false`.
    if (finishReason !== undefined && CONTENT_BLOCK_FINISH_REASONS.has(finishReason)) refused = true
    // M77: the INPUT-side block. It rides `promptFeedback.blockReason`, and
    // on that chunk `candidates` is absent entirely — a chunk that may be
    // the whole stream — so the candidate read above sees nothing and this
    // is the only place the refusal is visible. The recognised literal is
    // "the field arrived carrying a string"; no allow-list of values is
    // invented here, and the vendor's own enum is why that rule is safe:
    // its `BlockReason` values are BLOCK_REASON_UNSPECIFIED ("Default value.
    // This value is unused."), SAFETY, OTHER, BLOCKLIST, PROHIBITED_CONTENT
    // and IMAGE_SAFETY — every value means the prompt WAS blocked, and the
    // one "nothing here" marker is documented as unused, so an allow-list
    // would add nothing to the presence rule. (The enum is read from the
    // published REST doc ai.google.dev/api/generate-content; no vendor SDK
    // is installed in this tree to type against, so the residual is the DOC
    // being right, not a measurement here.)
    const blockReason = (event.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason
    if (typeof blockReason === "string") refused = true
    const parts = candidates?.[0]?.content?.parts ?? []
    for (const [index, part] of parts.entries()) {
      if (part.thought === true) {
        activeText = undefined
        if (activeThought?.index !== index) {
          const entry: { text: string; thoughtSignature?: string } = { text: "" }
          partOrder.push({ kind: "reasoning", index: thoughtParts.length })
          thoughtParts.push(entry)
          activeThought = { index, part: entry }
        }
        activeThought.part.text += part.text ?? ""
        if (part.thoughtSignature) {
          activeThought.part.thoughtSignature = part.thoughtSignature
          activeThought = undefined
        }
      } else {
        activeThought = undefined
        if (part.functionCall === undefined && part.thoughtSignature) {
          if (part.text === "") emptyTextSignatures.push(part.thoughtSignature)
          else textSignature = part.thoughtSignature
        }
        if (part.functionCall !== undefined) {
          activeText = undefined
          if (part.functionCall.name !== undefined) partOrder.push({ kind: "tool", index: pendingCalls.length })
        } else if (part.text === "" && part.thoughtSignature) {
          activeText = undefined
          partOrder.push({ kind: "text", text: "", thoughtSignature: part.thoughtSignature })
        } else if (typeof part.text === "string" && part.text.length > 0) {
          if (activeText?.index !== index) {
            const entry: Extract<ProviderBlockOrderEntry, { kind: "text" }> = { kind: "text", text: "" }
            partOrder.push(entry)
            activeText = { index, part: entry }
          }
          activeText.part.text += part.text
          if (part.thoughtSignature) { activeText.part.thoughtSignature = part.thoughtSignature; activeText = undefined }
        }
      }
      if (part.functionCall !== undefined) {
        handleFunctionCall(part.functionCall, part.thoughtSignature)
      } else if (typeof part.text === "string" && part.text.length > 0) {
        events.push(part.thought === true
          ? { type: "reasoning", blockId: String(thoughtParts.length - 1), text: part.text }
          : { type: "text/chunk", text: part.text })
      }
    }
    // M72 Ⅲ: `usageMetadata` rides the LAST chunk — mapped here instead of
    // only documented. (The sentence this replaces said THIS adapter does not
    // map `usageMetadata` onto the seam's `usage` event; this maps it.) The
    // wire's spelling is promptTokenCount → inputTokens, candidatesTokenCount
    // → outputTokens, cachedContentTokenCount → cacheReadTokens; anything
    // else the wire sends has no seam name and is not invented one.
    const usage = mapUsage(event.usageMetadata)
    if (usage !== undefined) events.push({ type: "usage", usage })
    return events
  }
  const finish = (): LLMStreamEvent => {
    // M77: each bit is written on its own (a response can be both), and both
    // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
    const visibleText = partOrder.filter((part): part is Extract<ProviderBlockOrderEntry, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("")
    const canonicalOrder: ProviderBlockOrderEntry[] = [
      ...thoughtParts.map((_, index) => ({ kind: "reasoning" as const, index })),
      ...(visibleText ? [{ kind: "text" as const, text: visibleText, ...(textSignature ? { thoughtSignature: textSignature } : {}) }] : []),
      ...emptyTextSignatures.map((thoughtSignature) => ({ kind: "text" as const, text: "", thoughtSignature })),
      ...callSignatures.map((_, index) => ({ kind: "tool" as const, index })),
    ]
    const needsPartOrder = JSON.stringify(partOrder) !== JSON.stringify(canonicalOrder)
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(callSignatures.some(Boolean) || thoughtParts.length || textSignature || emptyTextSignatures.length || needsPartOrder ? { providerContinuation: {
      kind: "gemini", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), callSignatures,
      ...(thoughtParts.length ? { thoughtParts } : {}),
      ...(textSignature ? { textSignature } : {}),
      ...(emptyTextSignatures.length ? { emptyTextSignatures } : {}),
      ...(needsPartOrder ? { partOrder } : {}),
      ...(callBindings.length ? { callBindings } : {}),
    } as const } : {}) }
  }
  return { handleChunk, finalizeCalls, finish }
}
