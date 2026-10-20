import { checkAbort, prefix } from '../bytes.ts'
import { digest, referenceId, type ContextStore } from '../store.ts'
import type { ContextCapture, ContextOutputConfig, ContextOutputService, ContextResultRef } from '../types.ts'

/** Execute one prepared legacy capture inside the service's admitted mutation
 * lane. Configuration remains live at the original reads/await boundaries. */
export async function captureLegacy(
  workspaceId: string,
  captured: ContextCapture,
  producer: Parameters<ContextOutputService['capture']>[2],
  getConfig: () => ContextOutputConfig,
  getStore: (signal: AbortSignal) => Promise<ContextStore>,
  owned: AbortSignal,
): Promise<ContextResultRef | undefined> {
  // A useful index needs fixed overhead. Avoid creating files for an
  // impossible disk budget and conservatively reserve index growth.
  if (getConfig().maxDiskBytes < 65536) return undefined
  const produced=producer ? await producer({maxBytes:getConfig().maxCaptureBytes,signal:owned}) : undefined
  checkAbort(owned)
  if(produced){
    if(typeof produced.text!=='string'||typeof produced.complete!=='boolean'||(produced.originalBytes!==undefined&&(!Number.isSafeInteger(produced.originalBytes)||produced.originalBytes<Buffer.byteLength(produced.text))))throw new Error('Invalid producer capture')
    captured.text=produced.text;captured.complete=produced.complete
  }
  const current = await getStore(owned)
  await current.prune()
  checkAbort(owned)
  const available = Math.max(0, Math.floor((getConfig().maxDiskBytes - await current.diskBytes() - 32768) / 3))
  const original = Buffer.from(captured.text, 'utf8')
  const bytes = prefix(original, Math.min(getConfig().maxCaptureBytes, available))
  if (original.length > 0 && bytes.length === 0) return undefined
  const revision = digest(bytes)
  const ref: ContextResultRef = {
    id: referenceId(workspaceId, captured.sessionId, captured.callId, revision),
    workspaceId: workspaceId, sessionId: captured.sessionId, callId: captured.callId,
    label: captured.label, revision, bytes: bytes.length, originalBytes: produced?.originalBytes ?? original.length,
    complete: captured.complete && bytes.length === (produced?.originalBytes ?? original.length),
    expiresAt: Date.now() + getConfig().retentionDays * 86400000,
    ...(captured.source ? { source: captured.source } : {}),
  }
  return current.put({ ref, ...(captured.source ? { source: captured.source } : {}) }, bytes, getConfig().maxDiskBytes, owned)
}
