import { append, type Session } from "@i-harness/core-session"
import { diagnosticsFor } from "@i-harness/diagnostics"
import { modelFailureFacts } from "@i-harness/llm-seam"
import type { CompactionResult, CompactionRunOptions } from "../index.ts"
import { selectShadowableRange, walkOffToolEvents } from "../region.ts"
import { safeActiveTokens } from "../projection/window.ts"
import { activeEvents, renderShadowed } from "../projection/shadowed.ts"
import { planPrune, surfaceTokensAfterPrune } from "./prune.ts"
import { prepareSummary, requestSummary } from "./summary.ts"
import { SummaryBlockedError, SummaryCheckpointError } from "../summarizer.ts"
import type { SummaryDependencies, CompactSettings } from "./contracts.ts"

const d = diagnosticsFor("turn")

/** Append-only projection owner. Cancellation and storage failure are terminal. */
export async function runCompactionPass(
  session: Session, allowPruneOnly: boolean, instructions: string | undefined,
  options: CompactionRunOptions | undefined, config: CompactSettings, contextWindow: number,
  deps: SummaryDependencies, overheadNow: () => number,
): Promise<CompactionResult> {
  const signal = options?.signal && deps.signal ? AbortSignal.any([options.signal, deps.signal]) : options?.signal ?? deps.signal
  const check = () => signal?.throwIfAborted()
  check()
  const startedAt = Date.now(), tokensBefore = safeActiveTokens(session)
  const emit = (outcome: string, extra: Record<string, unknown> = {}) => deps.telemetry?.emit({ type: "compaction/attempt", ts: Date.now(), data: { reason: options?.reason, outcome, tokensBefore, durationMs: Date.now() - startedAt, ...extra } })
  let shadowedSeqs = selectShadowableRange(session, config.retainTokens)
  // Retain the entire tail from the earliest protected event, walking backwards
  // when necessary so no call/result pair is separated by the protection cut.
  const protectedSet = new Set(options?.protectedSeqs ?? [])
  const protectedIndex = session.events.findIndex(event => event.seq !== undefined && protectedSet.has(event.seq))
  const cut = protectedIndex < 0 ? Infinity : walkOffToolEvents(session, protectedIndex)
  const safeSeqs = new Set(session.events.slice(0, cut).map(event => event.seq))
  shadowedSeqs = shadowedSeqs.filter(seq => safeSeqs.has(seq))
  if (!shadowedSeqs.length) { emit("skipped", { attempts: 0 }); return { compacted: false, shadowedSeqs: [] } }
  const protectedCalls = new Set(session.events.flatMap(event => (event.type === "tool/call" || event.type === "tool/result") && event.seq !== undefined && protectedSet.has(event.seq) ? [event.callId] : []))
  const pruneRecords = planPrune(session, config.prune).filter(record => !protectedCalls.has(record.callId))
  if (allowPruneOnly && pruneRecords.length && surfaceTokensAfterPrune(session, pruneRecords) + overheadNow() < contextWindow * config.thresholdRatio) {
    check(); append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords })
    await deps.flush?.(); check()
    emit("prune-only", { tokensAfter: safeActiveTokens(session), shadowed: 0, pruned: pruneRecords.length, attempts: 0 })
    return { compacted: true, shadowedSeqs: [], pruned: true }
  }
  if (pruneRecords.length) { check(); append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords }) }
  const prepared = prepareSummary(session, shadowedSeqs, config, deps)
  if (prepared.anchorSeq !== undefined && !protectedSet.has(prepared.anchorSeq) && safeSeqs.has(prepared.anchorSeq)) shadowedSeqs.push(prepared.anchorSeq)
  else if (prepared.anchorSeq !== undefined) prepared.previousSummary = undefined
  // A replayed prefix incorporates older active summaries within its cut. Text
  // replay incorporates only explicitly selected text plus the selected anchor.
  if (prepared.prefix) {
    const last = Math.max(...shadowedSeqs)
    for (const event of activeEvents(session)) if (event.type === "compaction/summary" && event.seq !== undefined && event.seq <= last && safeSeqs.has(event.seq)) shadowedSeqs.push(event.seq)
  }
  shadowedSeqs = [...new Set(shadowedSeqs)].sort((a, b) => a - b)
  const replayText = renderShadowed(session, shadowedSeqs, pruneRecords)
  const attemptsTracker = { count: 0 }
  let summary: string
  try {
    const result = await requestSummary(session, shadowedSeqs, replayText, prepared, config, contextWindow, deps, overheadNow, attemptsTracker, instructions, { ...options, signal })
    summary = result.text
  } catch (error) {
    check()
    if (error instanceof SummaryCheckpointError) throw error.failure
    if (["ABORTED", "CONTEXT_INPUT_STALE"].includes(modelFailureFacts(error)?.code ?? "") || error instanceof Error && error.name === "AbortError") throw error
    const safeReason = error instanceof SummaryBlockedError ? error.message : modelFailureFacts(error)?.message ?? "Summary request failed."
    d.warn(`[i-harness] compaction summarizer failed (fail-soft, retrying next step): ${safeReason}`)
    emit("failure", { attempts: attemptsTracker.count, ...(error instanceof SummaryBlockedError ? { blockedReason: safeReason } : {}) })
    return { compacted: false, shadowedSeqs: [], reason: "summarizer-failed", ...(error instanceof SummaryBlockedError ? { blockedReason: error.message } : {}) }
  }
  check()
  prepared.validateBeforeTransport()
  append(session, { type: "compaction/start" })
  append(session, { type: "compaction/summary", text: summary, shadowedSeqs })
  append(session, { type: "compaction/end" })
  await deps.flush?.(); check()
  emit("success", { tokensAfter: safeActiveTokens(session), shadowed: shadowedSeqs.length, pruned: pruneRecords.length, attempts: attemptsTracker.count })
  return { compacted: true, shadowedSeqs, summary, ...(pruneRecords.length ? { pruned: true } : {}) }
}
