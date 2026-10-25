import { checkAbort, prefix } from '../bytes.ts'
import { digest, referenceId, type ContextStore } from '../store.ts'
import type { ContextCapture, ContextOutputConfig, ContextOutputService, ContextResultRef } from '../types.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import type { LegacyUseLease } from './use-gate.ts'

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
    const available = Math.max(0, Math.floor((getConfig().maxDiskBytes - await current.diskBytes() - 32768) / 3))
    const bytes = prefix(original, Math.min(getConfig().maxCaptureBytes, available))
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
    return current.put(turn, lease, { ref, ...(source ? { source } : {}) }, bytes, getConfig().maxDiskBytes, owned)
  })
}
