import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonical, inside, key, missing, type Slot } from './discovery.ts'

export function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text); if (buffer.length <= bytes) return text
  return new TextDecoder().decode(buffer.subarray(0, Math.max(0, bytes)), { stream: true })
}
export interface ReadResult { body: string; contentHash?: string; hashScope?: 'full' | 'prefix'; observedSize?: number; failure?: 'unreadable' | 'absent' | 'outside-scope'; changed?: boolean; truncated: boolean }
export class InstructionReadCleanupError extends Error { constructor(cause: unknown) { super('Instruction file cleanup failed', { cause }) } }
const identity = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
export async function readSource(slot: Slot, allowance: number): Promise<ReadResult> {
  if (allowance <= 0) return { body: '', truncated: (slot.observedSize ?? 0) > 0, observedSize: slot.observedSize }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(slot.path, 'r')
    const before = await handle.stat(), root = await canonical(slot.scopeRoot), real = await fs.realpath(slot.path)
    if (!inside(root, real)) return { body: '', truncated: false, failure: 'outside-scope' }
    if (!before.isFile()) return { body: '', truncated: false, failure: 'unreadable' }
    const pathStat = await fs.stat(slot.path)
    if (identity(before) !== identity(pathStat) || (slot.canonicalPath && key(real) !== key(slot.canonicalPath))) return { body: '', truncated: false, changed: true }
    // The four-byte lookahead is shared across all chunks, not added per chunk.
    const limit = Math.min(Number.MAX_SAFE_INTEGER, allowance + 4), chunks: Buffer[] = []
    let count = 0, eof = false
    while (count < limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit - count))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count)
      if (!bytesRead) { eof = true; break }
      chunks.push(buffer.subarray(0, bytesRead)); count += bytesRead
    }
    const after = await handle.stat(), current = await fs.stat(slot.path), finalReal = await fs.realpath(slot.path)
    if (!inside(root, finalReal)) return { body: '', truncated: false, failure: 'outside-scope' }
    if (identity(before) !== identity(after) || identity(before) !== identity(current) || key(real) !== key(finalReal)) return { body: '', truncated: false, changed: true }
    const bytes = Buffer.concat(chunks), decoded = new TextDecoder().decode(bytes, { stream: !eof })
    return { body: utf8Prefix(decoded, allowance), contentHash: createHash('sha256').update(bytes).digest('hex'), hashScope: eof ? 'full' : 'prefix', observedSize: before.size, truncated: !eof || Buffer.byteLength(decoded) > allowance }
  } catch (e) { return { body: '', truncated: false, failure: missing(e) ? 'absent' : 'unreadable' } }
  finally { try { await handle?.close() } catch (error) { throw new InstructionReadCleanupError(error) } }
}
