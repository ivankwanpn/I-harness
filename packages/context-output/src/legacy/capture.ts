import { checkAbort, prefix } from '../bytes.ts'
import { digest, referenceId, type ContextStore } from '../store.ts'
import type { ContextCapture, ContextOutputConfig, ContextOutputService, ContextResultRef } from '../types.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'

/** Prepare the original producer outside both mutation lanes, then commit the
 * normalized bytes with a fresh physical quota decision in the shared turn. */
export async function captureLegacy(
  workspaceId: string,
  captured: ContextCapture,
  producer: Parameters<ContextOutputService['capture']>[2],
  getConfig: () => ContextOutputConfig,
  getStore: (signal: AbortSignal) => Promise<ContextStore>,
  mutate: <T>(store: ContextStore, work: (turn: WorkspaceMutationTurn) => Promise<T>) => Promise<T>,
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
  const current = await getStore(owned)
  return mutate(current, async turn => {
    checkAbort(owned)
    await current.prune(turn)
    checkAbort(owned)
    const available = Math.max(0, Math.floor((getConfig().maxDiskBytes - await current.diskBytes() - 32768) / 3))
    const bytes = prefix(original, Math.min(getConfig().maxCaptureBytes, available))
    if (original.length > 0 && bytes.length === 0) return undefined
    const revision = digest(bytes)
    const ref: ContextResultRef = {
      id: referenceId(workspaceId, captured.sessionId, captured.callId, revision),
      workspaceId, sessionId: captured.sessionId, callId: captured.callId,
      label: captured.label, revision, bytes: bytes.length, originalBytes,
      complete: captured.complete && bytes.length === originalBytes,
      expiresAt: Date.now() + getConfig().retentionDays * 86400000,
      ...(captured.source ? { source: captured.source } : {}),
    }
    return current.put(turn, { ref, ...(captured.source ? { source: captured.source } : {}) }, bytes, getConfig().maxDiskBytes, owned)
  })
}
