import { createHash } from 'node:crypto'
import { sameManagedArtifactRef } from '@i-harness/core-session'
import type { ResultPageQuery, ResultPageResult } from '@i-harness/session-executor'
import type { NativeIdentity } from './saved-process-index.ts'
import { validManagedArtifactRef, type ManagedArtifactRef } from '@i-harness/core-session'

/** Captures metadata from the committed envelope, never from preview or guest text.
 * A descriptor is not authorization; the original result reader must authorize it. */
export function savedResultDescriptor(value: unknown): { kind: 'artifact'; dto: ManagedArtifactRef; catalog?: ManagedArtifactRef } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const e = value as Record<string, any>
  if (e.execution?.outcome !== 'succeeded' || e.execution?.dispatch !== 'dispatched' || e.retention?.kind !== 'artifact') return
  const dto = e.retention.ref
  if (!validManagedArtifactRef(dto) || dto.codec !== 'json-utf8-v1' || dto.encodedBytes > 65536 || dto.completeness !== 'complete') return
  let catalog: ManagedArtifactRef | undefined
  if (e.dependencies !== undefined) {
    const d = e.dependencies
    if (!d || d.kind !== 'artifact-set' || d.count !== 1 || !validManagedArtifactRef(d.ref) || d.ref.codec !== 'json-utf8-v1' || d.ref.encodedBytes > 65536 || !['complete', 'source-limited'].includes(d.ref.completeness)) return
    catalog = Object.freeze({ ...d.ref })
  }
  return Object.freeze({ kind: 'artifact', dto: Object.freeze({ ...dto }), ...(catalog ? { catalog } : {}) })
}

function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text), stack: (Set<string> | null)[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') stack.push(new Set())
    else if (c === '[') stack.push(null)
    else if (c === '}' || c === ']') stack.pop()
    else if (c === '"') {
      const start = i
      for (i++; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break }
      let next = i + 1; while (next < text.length && /\s/.test(text[next]!)) next++
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string, keys = stack.at(-1)
        if (!keys || keys.has(key)) throw new Error('Duplicate JSON key')
        keys.add(key)
      }
    }
  }
  let nodes = 0
  const walk = (v: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 32) throw new Error('JSON limits exceeded')
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, depth + 1)
  }
  walk(value, 0); return value
}
export async function hydrateSavedDto(sessionId: string, descriptor: NonNullable<ReturnType<typeof savedResultDescriptor>>, selected: NativeIdentity,
  read: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>, guard: () => void): Promise<Record<string, unknown>> {
  const dto = Object.freeze({ ...descriptor.dto }), identity = Object.freeze({ ...selected })
  if (!validManagedArtifactRef(dto) || dto.codec !== 'json-utf8-v1' || dto.completeness !== 'complete' || dto.encodedBytes > 65536) throw new Error('Invalid DTO descriptor')
  const parts: Buffer[] = []; let offset = 0
  for (let count = 0; count < 128; count++) {
    guard(); const page = await read(sessionId, { ref: dto, offset, maxBytes: 32768 }); guard()
    if ('kind' in page || !('offset' in page) || !sameManagedArtifactRef(dto, page.ref) || page.offset !== offset || typeof page.eof !== 'boolean' || page.data.kind !== 'text' || typeof page.data.text !== 'string' || Buffer.byteLength(JSON.stringify(page)) > 32768) throw new Error('Invalid DTO page')
    const bytes = Buffer.from(page.data.text, 'utf8')
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== page.data.text) throw new Error('Lossy DTO text')
    const end = offset + bytes.length
    if (!Number.isSafeInteger(end) || end > dto.encodedBytes) throw new Error('Invalid DTO length')
    parts.push(bytes)
    if (page.eof) {
      if (page.nextOffset !== null || end !== dto.encodedBytes) throw new Error('Invalid DTO EOF')
      const body = Buffer.concat(parts)
      if (createHash('sha256').update(body).digest('hex') !== dto.contentDigest) throw new Error('DTO digest mismatch')
      const parsed = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(body))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid DTO')
      const value = parsed as Record<string, any>, n = value.native_job
      if (value.job_id !== identity.jobId || !n || n.version !== 1 || n.jobId !== identity.jobId || n.instanceId !== identity.instanceId || n.ownerSessionId !== identity.ownerSessionId || n.sourceId !== identity.sourceId || sessionId !== identity.ownerSessionId || value.offset_bytes !== undefined && value.offset_bytes !== 0 || value.error !== undefined) throw new Error('DTO identity mismatch')
      guard(); return value
    }
    if (!bytes.length || page.nextOffset !== end || end >= dto.encodedBytes) throw new Error('Invalid DTO progress')
    offset = end
  }
  throw new Error('DTO page limit exceeded')
}
