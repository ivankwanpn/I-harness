import type { ExecutionSettlement, StopReason } from "@i-harness/sandbox"
import { cleaned, type CleanupOutcome, type Entry } from "./contracts.ts"

export function cleanupOutcome(result: ExecutionSettlement): CleanupOutcome {
  return result.kind === "incomplete"
    ? { kind: "failed", cause: new Error(`Execution cleanup incomplete (${result.phase}): ${result.detail}`) } : cleaned
}

export function cleanupDetail(cause: unknown): string {
  // Rejections are opaque values. Diagnostics must not replace their identity
  // or introduce another failure when a value cannot be converted to text.
  try { return cause instanceof Error ? cause.message : String(cause) }
  catch { return "unprintable cleanup cause" }
}

interface RetirementOwner {
  owns(entry: Entry): boolean
  remove(entry: Entry): void
}

export function createRetirement({ owns, remove }: RetirementOwner) {
  function watch(entry: Entry, attempt: Promise<ExecutionSettlement>): void {
    if (entry.observed.has(attempt)) return
    entry.observed.add(attempt)
    // Attach both observers immediately. A rejected driver promise leaves its
    // ownership intact and is reported by the next explicit cleanup operation.
    void attempt.then(result => {
      if (result.kind === "settled") remove(entry)
    }, () => {})
  }

  function markStopped(entry: Entry, reason: StopReason, cause: unknown = reason): void {
    entry.stopReason ??= reason
    if (!entry.controller.signal.aborted) entry.controller.abort(cause)
  }

  function cancelEntry(entry: Entry, reason: StopReason): Promise<ExecutionSettlement> {
    markStopped(entry, reason)
    try {
      const attempt = entry.handle!.cancel(reason)
      watch(entry, attempt)
      return attempt
    } catch (cause) {
      const rejected = Promise.reject<ExecutionSettlement>(cause)
      void rejected.catch(() => {})
      return rejected
    }
  }

  async function drain(entry: Entry): Promise<CleanupOutcome> {
    // A launch already awaiting rollback or a late committed handle performs
    // its own first cleanup. Joining it must not implicitly retry an incomplete
    // attempt and accidentally acknowledge a failed revocation.
    if (entry.preparing) return entry.completion
    if (!owns(entry)) return cleaned
    if (entry.handle) {
      try { return cleanupOutcome(await cancelEntry(entry, entry.stopReason ?? "shutdown")) }
      catch (cause) { return { kind: "failed", cause } }
    }
    if (entry.rollbackFailed && entry.prepared) {
      if (!entry.rollbackAttempt) {
        const attempt = Promise.resolve().then(async (): Promise<CleanupOutcome> => {
          try {
            await entry.prepared!.rollback()
            entry.rollbackFailed = false
            remove(entry)
            return cleaned
          } catch (cause) { return { kind: "failed", cause } }
        })
        entry.rollbackAttempt = attempt
        void attempt.then(() => { if (entry.rollbackAttempt === attempt) entry.rollbackAttempt = undefined })
      }
      return entry.rollbackAttempt
    }
    return cleaned
  }

  async function drainAll(affected: readonly Entry[], operation: string): Promise<void> {
    const outcomes = await Promise.all(affected.map(drain))
    const errors = outcomes.flatMap(outcome => outcome.kind === "failed" ? [outcome.cause] : [])
    if (errors.length) throw new AggregateError(errors, `${operation} failed: ${errors.map(cleanupDetail).join("; ")}`)
  }

  return { watch, markStopped, cancelEntry, drainAll }
}
