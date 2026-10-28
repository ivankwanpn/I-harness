import { createHash } from 'node:crypto'
import { sameManagedArtifactRef } from '@i-harness/core-session'
import type { ResultPageQuery, ResultPageResult } from '@i-harness/session-executor'
import { captureSavedBinding, validateSavedOutput } from './saved-output-binding.ts'
import type { NativeIdentity, SavedCall, SavedCandidate } from './saved-process-index.ts'
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
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid JSON syntax') }
  const stack: (Set<string> | null)[] = []
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
    if (typeof v === 'string' && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(v, 'utf8')) !== v) throw new Error('Lossy JSON string')
    if (++nodes > 8192 || depth > 32) throw new Error('JSON limits exceeded')
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, depth + 1)
  }
  walk(value, 0); return value
}
async function hydrateJson(sessionId: string, ref: ManagedArtifactRef, read: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>, guard: () => void, label: string): Promise<Record<string, any>> {
  if (!validManagedArtifactRef(ref) || ref.codec !== 'json-utf8-v1' || !['complete', 'source-limited'].includes(ref.completeness) || ref.encodedBytes > 65536) throw new Error('Invalid JSON descriptor')
  const parts: Buffer[] = []; let offset = 0
  for (let count = 0; count < 128; count++) {
    guard(); const page = await read(sessionId, { ref: { ...ref }, offset, maxBytes: 32768 }); guard()
    if (!page || 'kind' in page || !('offset' in page) || !validManagedArtifactRef(page.ref) || !sameManagedArtifactRef(ref, page.ref) || page.offset !== offset || typeof page.eof !== 'boolean' || !page.data || page.data.kind !== 'text' || typeof page.data.text !== 'string' || Buffer.byteLength(JSON.stringify(page)) > 32768) throw new Error('Invalid JSON page')
    const bytes = Buffer.from(page.data.text, 'utf8')
    // Preserve the source bytes, including BOM; escaped lone surrogates are also checked after parsing.
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== page.data.text) throw new Error('Lossy JSON text')
    const end = offset + bytes.length
    if (!Number.isSafeInteger(end) || end > ref.encodedBytes) throw new Error('Invalid JSON length')
    parts.push(bytes)
    if (page.eof) {
      if (page.nextOffset !== null || end !== ref.encodedBytes) throw new Error('Invalid JSON EOF')
      const body = Buffer.concat(parts)
      if (createHash('sha256').update(body).digest('hex') !== ref.contentDigest) throw new Error(label + ' digest mismatch')
      const parsed = strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON object')
      guard(); return parsed as Record<string, any>
    }
    if (!bytes.length || page.nextOffset !== end || end >= ref.encodedBytes) throw new Error('Invalid JSON progress')
    offset = end
  }
  throw new Error('JSON page limit exceeded')
}
export async function hydrateSavedDto(sessionId: string, descriptor: NonNullable<ReturnType<typeof savedResultDescriptor>>, selected: NativeIdentity,
  read: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>, guard: () => void, original: SavedCall): Promise<Record<string, unknown>> {
  const dto = Object.freeze({ ...descriptor.dto }), catalog = descriptor.catalog && Object.freeze({ ...descriptor.catalog }), identity = Object.freeze({ ...selected })
  if (sessionId !== identity.ownerSessionId || dto.completeness !== 'complete') throw new Error('Invalid DTO owner or completeness')
  const args = captureSavedBinding({ kind: 'artifact', dto, catalog }, identity, original)
  // Validate both descriptors before any I/O. A supplied descriptor never creates body authority.
  if (!catalog || !validManagedArtifactRef(catalog) || catalog.codec !== 'json-utf8-v1' || !['complete', 'source-limited'].includes(catalog.completeness) || catalog.encodedBytes > 65536) throw new Error('Invalid catalog descriptor')
  const value = await hydrateJson(sessionId, dto, read, guard, 'DTO')
  const parsedCatalog = await hydrateJson(sessionId, catalog, read, guard, 'Catalog')
  validateSavedOutput(value, identity, args, parsedCatalog)
  guard(); return value
}

/** Bind parser output back to the fixed selected index row; this grants no read authority. */
export async function hydrateSavedCandidate(sessionId: string, candidate: SavedCandidate,
  read: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>, guard: () => void) {
  if (candidate.conflict || !candidate.nativeJob || !candidate.descriptor || !candidate.observation) throw new Error('Selected artifact observation unavailable')
  const selected = structuredClone(candidate)
  const value = await hydrateSavedDto(sessionId, selected.descriptor!, selected.nativeJob!, read, guard, selected.observation!)
  const previous = selected.snapshot as Record<string, any> | undefined, full = value.full_result as Record<string, any>
  if (previous?.full_result !== undefined && (!validManagedArtifactRef(previous.full_result?.args?.ref) || !sameManagedArtifactRef(previous.full_result.args.ref, full.args.ref))) throw new Error('Conflicting original native frame ref')
  if (previous && ['total_bytes', 'stderr_total_bytes', 'total_raw_bytes', 'digest', 'stderr_digest', 'digest_format', 'completeness'].some(key => previous[key] !== undefined && previous[key] !== value[key])) throw new Error('Conflicting original native summary')
  guard()
  return { value, catalogCompleteness: selected.descriptor!.catalog!.completeness }
}
