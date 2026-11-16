import { checkAbort, prefix } from '../bytes.ts'
import { digest, referenceId, type ContextStore } from '../store.ts'
import type { ContextCapture, ContextOutputConfig, ContextOutputService, ContextResultRef } from '../types.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import type { LegacyUseLease } from './use-gate.ts'

const nativeQuotaFailure = (failure: unknown): boolean => {
  const seen = new Set<unknown>()
  for (let current: unknown = failure; current && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current)
    const message = current instanceof Error ? current.message : String(current)
    if (/database or disk is full/i.test(message)) return true
  }
  return false
}
/** Prepare the original producer outside both mutation lanes, then commit the
 * normalized bytes with a fresh physical quota decision in the shared turn. */
export async function captureLegacy(
  workspaceId: string,
  captured: ContextCapture,
  producer: Parameters<ContextOutputService['capture']>[2],
  getConfig: () => ContextOutputConfig,
  schedule: <T>(work: (store: ContextStore, turn: WorkspaceMutationTurn, lease: LegacyUseLease) => Promise<T>) => Promise<T>,
  owned: AbortSignal,
): Promise<ContextResultRef | undefined> {
  // A useful index needs fixed overhead. Avoid creating files for an
  // impossible disk budget and conservatively reserve index growth.
  if (getConfig().maxDiskBytes < 65536) return undefined
  const produced = producer ? await producer({ maxBytes: getConfig().maxCaptureBytes, signal: owned }) : undefined
  checkAbort(owned)
  if (produced) {
    if (typeof produced.text !== 'string' || typeof produced.complete !== 'boolean'
      || (produced.originalBytes !== undefined && (!Number.isSafeInteger(produced.originalBytes)
        || produced.originalBytes < Buffer.byteLength(produced.text)))) throw new Error('Invalid producer capture')
    captured.text = produced.text; captured.complete = produced.complete
  }
  const original = Buffer.from(captured.text, 'utf8')
  const originalBytes = produced?.originalBytes ?? original.length
  return schedule(async (current, turn, lease) => {
    checkAbort(owned)
    await current.prune(turn, lease)
    checkAbort(owned)
    if (await current.ensureIndex(turn, lease, getConfig().maxDiskBytes) !== 'ready') throw Error(current.indexIssue()?.message ?? 'Derived context index unavailable')
    const budget = await current.captureBudget(turn, lease, getConfig().maxDiskBytes)
    const bytes = prefix(original, Math.min(getConfig().maxCaptureBytes, budget.available))
    if (original.length > 0 && bytes.length === 0) return undefined
    const revision = digest(bytes)
    // The canonical JSON manifest omits undefined optional source fields. Keep
    // the live map/returned ref identical to that original persisted metadata.
    const source = captured.source ? Object.fromEntries(Object.entries(captured.source).filter(([, value]) => value !== undefined)) as NonNullable<ContextCapture['source']> : undefined
    const ref: ContextResultRef = {
      id: referenceId(workspaceId, captured.sessionId, captured.callId, revision),
      workspaceId, sessionId: captured.sessionId, callId: captured.callId,
      label: captured.label, revision, bytes: bytes.length, originalBytes,
      complete: captured.complete && bytes.length === originalBytes,
      expiresAt: Date.now() + getConfig().retentionDays * 86400000,
      ...(source ? { source } : {}),
    }
    try { return await budget.put({ ref, ...(source ? { source } : {}) }, bytes, owned) }
    // A native SQLite page budget can refuse its derived index write after the
    // managed body was admitted. The capture is already rolled back; report the
    // same truthful "none" disposition as every other legacy quota refusal.
    catch (failure) { if (nativeQuotaFailure(failure)) return undefined; throw failure }
  })
}
