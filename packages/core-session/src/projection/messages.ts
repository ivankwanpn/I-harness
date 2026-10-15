import type { Session, SessionEvent } from "../events/types.ts"
import { imageDescriptor } from "../images.ts"
import type { ImageInput } from "../images.ts"
import { derivePruneSubstitutes, renderPruneSubstitute } from "./pruning.ts"
import { meldRewindCut } from "./rewind.ts"
import type { RewindCut } from "./rewind.ts"
import type { LLMMessage, ProviderThinkingBlock, ProviderContinuation } from "./types.ts"

/** M5/D2: the projection as of a PREFIX of the log — `maxSeq` inclusive.
 *
 * The summarizer uses this to send a byte-prefix of the last main request, so
 * its own call can reuse the provider's cache instead of paying full price for
 * the whole conversation. Built through the SAME fold as deriveMessages, so the
 * two cannot drift; that identity is the entire reason the cache can hit.
 *
 * Correct only when the cut is block-aligned — a boundary inside a tool block
 * would project a different message list here than the main path sends. The
 * compaction module guarantees that by walking its boundary off tool events.
 *
 * M78 — the `compaction/prune` exception, stated here so it is not read as a
 * bug: a prune marker is CONTENT-ADDRESSED, not time-scoped.
 * `derivePruneSubstitutes` keys its map by tool call id, and the substitute is a
 * property of that OLD TOOL OUTPUT — the same bytes at whatever moment the fold
 * is taken — so applying the map to ANY fold is exactly right. That is what
 * keeps this function's output a leading slice of `deriveMessages`: with the
 * marker invisible, the prefix showed the RAW output where the main fold shows
 * the substitute, and the divergence sat at exactly the shared position the
 * region replay exists to preserve (measured, M78; pinned by "the request stays
 * a LEADING SLICE of the main fold across a prune marker").
 *
 * WHERE the marker sits past the cut is structural, not incidental: a pass plans
 * the prune BEFORE it folds, appends its marker to the END of the log (`append`
 * hands out `events.length` as the seq), and then cuts the fold at the region's
 * last shadowed seq — so a plain `seq <= maxSeq` filter hides exactly the
 * directive the fold needs. No placement of the append can avoid it (measured,
 * M78: lastShadowed 104/109 vs markerSeq 110 on the compaction fixture; no
 * mutation of the append site fixed it).
 *
 * The exception is deliberately NARROW: `compaction/summary` and
 * `compaction/reset` markers ARE time-scoped — their `shadowedSeqs` /
 * `removedSeqs` name a region of the log — so they keep obeying the seq filter;
 * a fold as of an earlier prefix must not be rewritten by a LATER compaction's
 * decision.
 */
export function deriveMessagesUpTo(session: Session, maxSeq: number): LLMMessage[] {
  return deriveMessages({
    ...session,
    // M78: the content-addressed directive is kept wherever its marker sits (see
    // the docstring) — not a general "markers ignore maxSeq" rule.
    events: session.events.filter((e) => e.seq === undefined || e.seq <= maxSeq || e.type === "compaction/prune"),
  })
}

export function deriveMessages(session: Session): LLMMessage[] {
  const result: LLMMessage[] = []
  // New inbox-backed prompts keep their bytes on the durable admission. Read
  // admissions even when compaction or rewind hides them from model-visible
  // history: the later user/message still needs its image payload. Walking in
  // log order means a reused inputId resolves only to its latest EARLIER entry.
  const admittedImages = new Map<string, ImageInput[]>()
  // A tool block is one step of assistant toolCalls followed by its tool
  // results. Both are buffered and flushed together (assistant toolCalls
  // FIRST, then tool results) so the model-visible order matches what the
  // APIs expect (function_call before function_call_output / tool_use before
  // tool_result), regardless of how the session log interleaves them.
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  // Tool-result images are model-visible user content, but all results of a
  // parallel tool block must remain adjacent for protocol adapters to return
  // them together before any image/text user content.
  const pendingToolImages: LLMMessage[] = []
  // M52/L3: user messages that land while the step's tool-call block is open
  // (guard-repeat-tool's reminder from agent/post-tool) are buffered and
  // emitted right AFTER that block — see the user/message branch. Without the
  // buffer the immediate flush split the step: assistant("",toolCalls) →
  // tool → user(reminder) → assistant(stepText).
  const deferredUser: LLMMessage[] = []
  // M51/B2: whether a step/start..step/end window is open. The agent loop
  // appends the step's assistant/message before tool execution, so a failed
  // tool still leaves the signed provider continuation in the durable log.
  // "The current step's tool block is still open" is exactly
  // `stepOpen && pendingCalls !== undefined` (core-agent appends step/start
  // unconditionally at the top of every step).
  let stepOpen = false
  // An early assistant/message can flush the call list before the tools have
  // returned. Keep the result block open until step/end so post-tool user
  // reminders cannot split parallel tool results.
  let toolResultsPending = false
  // M11 compaction shadow pre-pass: collect every seq a compaction/summary
  // replaced on the surface so the render pass skips them. The raw log keeps
  // all events; only this projection shrinks.
  // M20 fix round 1 (Ruling 4): `compaction/reset` markers join the SAME
  // shadow mechanism — their `removedSeqs` are collected additively, so an
  // append-only resetWindow hides exactly its removed tail without ever
  // truncating the durable log.
  // M42 (G2): the rewind cut windows are collected in the SAME single pre-pass
  // — a session without rewind/point events pays nothing extra (zero-change
  // fast path; rewindCuts is exported for callers that only need the resolved
  // view). Once resolved, the skip test costs O(cuts) per event.
  const shadowed = new Set<number>()
  const cuts: RewindCut[] = []
  for (const ev of session.events) {
    if (ev.type === "compaction/summary") for (const seq of ev.shadowedSeqs) shadowed.add(seq)
    // defensive `?? []`: persisted logs bypass append validation, so a
    // malformed marker without removedSeqs must not throw here
    else if (ev.type === "compaction/reset") for (const seq of ev.removedSeqs ?? []) shadowed.add(seq)
    // defensive (Ruling 7): a malformed persisted rewind/point without a
    // numeric seq/anchorSeq (or with an empty window) contributes no cut
    else if (ev.type === "rewind/point") {
      if (typeof ev.seq === "number" && typeof ev.anchorSeq === "number" && ev.anchorSeq < ev.seq) {
        meldRewindCut(cuts, ev.anchorSeq, ev.seq)
      }
    }
  }
  // M33 model-free prune pass: the substitute map is applied to the
  // tool/result projection ONLY (the raw log keeps the full output).
  const pruned = derivePruneSubstitutes(session)
  // A provider stream may emit tool calls and then fail before any tool runs.
  // Keep those raw events for diagnostics, but never replay them as unanswered
  // tool_use blocks. A failed step also stays suppressed after cold-tail repair
  // has inserted synthetic results for its outstanding calls.
  const resolvedCallIds = new Set<string>()
  for (const ev of session.events) {
    if (ev.seq !== undefined && (shadowed.has(ev.seq) || hideByRewind(ev.seq))) continue
    if (ev.type === "tool/result") resolvedCallIds.add(ev.callId)
  }
  const suppressedCallIds = new Set<string>()
  const suppressedAssistantEvents = new Set<SessionEvent>()
  // Compaction replaces model-visible content, not the step's lifecycle.
  // A summary can shadow the current step/start before that step produces its
  // assistant/tool response. Retain these boundaries in both stateful folds
  // so the continuation stays attached and failed steps remain suppressed.
  // Rewind still removes its entire abandoned branch, including boundaries.
  const stepBoundaries = new Set(["step/start", "step/end", "step/failed", "turn/start"])
  let activeStep: { calls: string[]; assistants: SessionEvent[]; failed: boolean } | undefined
  const closeStep = () => {
    if (activeStep && (activeStep.failed || activeStep.calls.some((id) => !resolvedCallIds.has(id)))) {
      for (const id of activeStep.calls) suppressedCallIds.add(id)
      for (const event of activeStep.assistants) suppressedAssistantEvents.add(event)
    }
    activeStep = undefined
  }
  for (const ev of session.events) {
    if (ev.seq !== undefined && (hideByRewind(ev.seq) || shadowed.has(ev.seq) && !stepBoundaries.has(ev.type))) continue
    if (ev.type === "step/start") {
      closeStep()
      activeStep = { calls: [], assistants: [], failed: false }
    } else if (ev.type === "tool/call") activeStep?.calls.push(ev.callId)
    else if (ev.type === "assistant/message") activeStep?.assistants.push(ev)
    else if (ev.type === "step/failed") {
      if (activeStep) activeStep.failed = true
      closeStep()
    } else if (ev.type === "step/end" || ev.type === "turn/start") closeStep()
  }
  closeStep()
  // M42 (G2): a seq is skipped when EITHER a compaction marker shadowed it OR
  // a rewind cut window contains it (union, not substitution — a rewind NEVER
  // un-shadows a compaction's removed seqs, inside or outside cut windows).
  // ORDER rule: events with seq >= a cut's markerSeq (new turns appended after
  // the rewind) stay INCLUDED unless a LATER cut's window covers them — each
  // resolved window is disjoint, so the per-window predicate above is exact.
  // Unkeyed events (seq === undefined) are never hidden (compaction/reset
  // precedent).
  for (const ev of session.events) {
    if (ev.type === "agent/input/admitted") {
      if (ev.images?.length) admittedImages.set(ev.inputId, ev.images)
      else admittedImages.delete(ev.inputId)
    }
    if (ev.seq !== undefined && (hideByRewind(ev.seq) || shadowed.has(ev.seq) && !stepBoundaries.has(ev.type))) continue
    if (ev.type === "user/message") {
      const images = ev.imageInputId === undefined ? ev.images : admittedImages.get(ev.imageInputId)
      if (ev.imageInputId !== undefined && !images?.length) {
        throw new Error(`image admission not found for user/message: ${ev.imageInputId}`)
      }
      const message: LLMMessage = images && images.length > 0
        ? { role: "user", content: [{ type: "text", text: ev.text }, ...images.map((image) => ({ type: "image" as const, image }))] }
        : { role: "user", content: ev.text }
      // M52/L3: mid-step while the step's tool-call block is open (the ONLY
      // in-tree producer is guard-repeat-tool's agent/post-tool reminder):
      // defer past the block so the step's text still folds into its calls
      // message (M51/B2) and the reminder follows the results. Every other
      // user/message position (turn start, the agent/pre-step boundary before
      // the first tool call, after step/end) keeps the immediate push.
      if (stepOpen && (pendingCalls || toolResultsPending)) {
        deferredUser.push(message)
      } else {
        flushToolBlock()
        result.push(message)
      }
    } else if (ev.type === "assistant/message") {
      if (suppressedAssistantEvents.has(ev)) continue
      // M51/B2 (M3 shape): when the step's tool block is still open, the
      // step's text belongs to the SAME assistant message as its tool calls —
      // `assistant(text + toolCalls)` — not a separate message after the
      // results (which made the model read its pre-tool narration as
      // post-tool commentary). The results follow the folded message, so the
      // M10a `assistant(toolCalls) -> tool(result)` adjacency is preserved.
      // A message outside an open step (e.g. a step-less log, or the final
      // answer after step/end) keeps the pre-fold behavior: its own message.
      if (stepOpen && pendingCalls) {
        toolResultsPending = true
        flushToolBlock(ev.text, ev.thinkingBlocks, ev.providerContinuation)
      } else {
        flushToolBlock()
        result.push({ role: "assistant", content: ev.text, ...(ev.thinkingBlocks?.length ? { thinkingBlocks: ev.thinkingBlocks } : {}), ...(ev.providerContinuation ? { providerContinuation: ev.providerContinuation } : {}) })
      }
    } else if (ev.type === "step/start") {
      stepOpen = true
    } else if (ev.type === "turn/start") {
      // M52/L3: a turn boundary always closes the previous step window. An
      // aborted/failed turn throws WITHOUT step/end, so the next turn's
      // user/message would otherwise be deferred into that dangling tool
      // block (core-agent agent.test.ts "per-call signal aborts the current
      // turn"). Well-formed turns already end every step before turn/end, so
      // this reset is a no-op for them.
      stepOpen = false
      toolResultsPending = false
    } else if (ev.type === "compaction/summary") {
      flushToolBlock()
      result.push({ role: "user", content: ev.text })
    } else if (ev.type === "tool/call") {
      if (!resolvedCallIds.has(ev.callId) || suppressedCallIds.has(ev.callId)) continue
      pendingCalls ??= []
      pendingCalls.push({ id: ev.callId, name: ev.name, args: ev.args })
    } else if (ev.type === "tool/result") {
      if (suppressedCallIds.has(ev.callId)) continue
      const out = ev.output as { images?: ImageInput[] } | null | undefined
      const images = out?.images
      // M33: a pruned callId is projected as its substitute — the raw output
      // stays durably in the log; only the model-visible text narrows.
      const record = pruned.get(ev.callId)
      pendingResults.push({ role: "tool", toolCallId: ev.callId, content: record !== undefined ? renderPruneSubstitute(record) : toolResultText(ev.output), ...(ev.isError === true ? { isError: true } : {}) })
      // Defensive (M14 spec §8): persisted logs bypass append validation (CLI
      // resume merges via events.push; fromJSONL does not validate), so a
      // truthy non-array `output.images` must NOT throw — treat the output as
      // plain data and flush no synthetic user message.
      if (Array.isArray(images) && images.length > 0) {
        pendingToolImages.push({
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            ...images.map((image) => ({ type: "image" as const, image })),
          ],
        })
      }
    } else if (ev.type === "step/end" || ev.type === "step/failed") {
      // Each step is a self-contained [assistant toolCalls -> tool results]
      // unit; flushing at step/end keeps per-turn tool blocks separate so the
      // log never folds across steps into consecutive user/tool-result runs
      // (which would violate Anthropic's Messages API role alternation).
      stepOpen = false
      toolResultsPending = false
      flushToolBlock()
    }
    // assistant/chunk events carry no model-visible text; skipped entirely
  }
  flushToolBlock()
  return result

  // M42 (G2): O(cuts) per event — a no-rewind session has cuts === [] so the
  // loop body never runs (path-identical to pre-M42 deriveMessages).
  function hideByRewind(seq: number): boolean {
    for (const cut of cuts) {
      if (seq >= cut.cutFrom && seq < cut.markerSeq) return true
    }
    return false
  }

  // `content` is the folded step text (M51/B2); every no-text caller passes
  // nothing and gets the historical `content: ""` message byte-for-byte.
  function flushToolBlock(content = "", thinkingBlocks?: ProviderThinkingBlock[], providerContinuation?: ProviderContinuation) {
    if (pendingCalls) {
      result.push({ role: "assistant", content, toolCalls: pendingCalls, ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) })
      pendingCalls = undefined
    }
    if (pendingResults.length > 0) {
      result.push(...pendingResults)
      pendingResults.length = 0
    }
    if (pendingToolImages.length > 0) {
      result.push(...pendingToolImages)
      pendingToolImages.length = 0
    }
    // M52/L3: the block is complete — the deferred mid-step user messages
    // follow it (they were logged after the results they interleaved with).
    if (deferredUser.length > 0) {
      result.push(...deferredUser)
      deferredUser.length = 0
    }
  }
}

/** M61: the MODEL-VISIBLE text of a tool result. An output carrying images
 * keeps them OUT of the text — the base64 rides the follow-up user message as
 * real image parts, so stringifying the envelope put megabytes of base64 in
 * front of the model as text too (a 1 MB image ≈ 1.4 M chars of prompt). The
 * shape mirrors deriveSearchText's rule: objects lose `images` (described by
 * the short descriptor instead), arrays and primitives stringify as-is. */
function toolResultText(output: unknown): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return JSON.stringify(output) ?? String(output)
  }
  const record = output as Record<string, unknown>
  const images = record["images"]
  // Only a REAL image array is stripped — a malformed `images` member stays
  // part of the faithful payload (the M14 defensive rule for persisted logs).
  if (!Array.isArray(images) || images.length === 0) return JSON.stringify(output) ?? String(output)
  const { images: _images, ...rest } = record
  const hasRest = Object.keys(rest).length > 0
  const restText = hasRest ? (JSON.stringify(rest) ?? String(rest)) : ""
  const descriptor = imageDescriptor(images as ImageInput[])
  return hasRest ? restText + descriptor : descriptor.trimStart()
}
