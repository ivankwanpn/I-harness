import { integer } from './config.ts'
import type { ContextResultRef } from './types.ts'

export function renderContextRecovery(refs: readonly ContextResultRef[], maxBytes = 16 * 1024): string {
  integer(maxBytes, 'recovery budget')
  const entries: { id: string; revision: string; bytes: number; originalBytes: number; complete: boolean; expiresAt: number }[] = []
  const render = () => `Context Mode output references (source material):\n${JSON.stringify({ refs: entries })}`
  if (Buffer.byteLength(render()) > maxBytes || refs.length === 0) return ''
  for (const ref of refs) {
    // Labels, source paths, session/call IDs, and captured text can contain
    // instructions. Recovery only carries fixed-format IDs and scalar facts.
    if (!/^ctx_[a-f0-9]{64}$/.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.revision)) continue
    entries.push({ id: ref.id, revision: ref.revision, bytes: ref.bytes, originalBytes: ref.originalBytes, complete: ref.complete, expiresAt: ref.expiresAt })
    if (Buffer.byteLength(render()) > maxBytes) { entries.pop(); break }
  }
  return entries.length ? render() : ''
}
