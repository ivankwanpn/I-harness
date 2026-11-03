import type { ArtifactQualificationIO } from './qualification-io.ts'
import { validManagedArtifactRef, type ManagedArtifactRef, type ResultDependency } from '@i-harness/core-session'
import { isMetadataData } from './metadata-data.ts'
import { identity } from '../config.ts'
import { sha } from './manifest.ts'
import { readVerifiedArtifactBytes } from './reader.ts'

export function dependencyEntries(entries: readonly ResultDependency[]): readonly ResultDependency[] {
  if (!Array.isArray(entries) || !isMetadataData(entries) || !entries.length) throw new Error('Original dependency entries unavailable')
  const ids = new Set<string>()
  for (const entry of entries) {
    identity(entry.sourceId, 'sourceId')
    if (ids.has(entry.sourceId) || entry.kind !== 'exec-frames' || Object.keys(entry).some(key => !['kind', 'sourceId', 'retention'].includes(key))) throw new Error('Original dependency entries conflict')
    ids.add(entry.sourceId)
    const retention = entry.retention
    if (retention.kind === 'artifact') {
      if (Object.keys(retention).some(key => !['kind', 'ref'].includes(key)) || !validManagedArtifactRef(retention.ref) || retention.ref.codec !== 'exec-frames-v1') throw new Error('Original dependency reference unavailable')
    } else if (retention.kind !== 'unavailable' || Object.keys(retention).some(key => !['kind', 'reason', 'observedEncodedBytes'].includes(key)) || !['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason)
      || retention.observedEncodedBytes !== undefined && (!Number.isSafeInteger(retention.observedEncodedBytes) || retention.observedEncodedBytes < 0)) throw new Error('Original dependency refusal unavailable')
  }
  const frozen = structuredClone(entries)
  for (const entry of frozen) { if (entry.retention.kind === 'artifact') Object.freeze(entry.retention.ref); Object.freeze(entry.retention); Object.freeze(entry) }
  return Object.freeze(frozen)
}

/** JSON.parse validates grammar; this separate lexical pass refuses duplicate
 * object keys (including escaped aliases) before parsed data is used. Its input
 * is a single bounded descriptor, never the complete catalog. */
function parseDescriptor(text: string): unknown {
  const value: unknown = JSON.parse(text), objects: (Set<string> | null)[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{') objects.push(new Set())
    else if (char === '[') objects.push(null)
    else if (char === '}' || char === ']') objects.pop()
    else if (char === '"') {
      const start = i
      for (i++; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break }
      let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string, keys = objects.at(-1)
        if (!keys || keys.has(key)) throw new Error('Duplicate catalog descriptor key')
        keys.add(key)
      }
    }
  }
  return value
}

/** Verified 32KiB pages, at most 8192 encoded bytes per descriptor. Only the
 * sourceId hash set grows with count. The callback is metadata traversal, not a
 * commit hook: callers must await successful EOF before target mutations. */
export async function readDependencyCatalog(root: string, directory: string, ref: ManagedArtifactRef,
  visit: (entry: ResultDependency, ordinal: number) => void | Promise<void>, expectedCount?: number, io?: ArtifactQualificationIO): Promise<number> {
  if (!validManagedArtifactRef(ref) || ref.codec !== 'json-utf8-v1' || expectedCount !== undefined && (!Number.isSafeInteger(expectedCount) || expectedCount < 0)) throw new Error('Dependency catalog unavailable')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let offset = 0, page = '', cursor = 0, ended = false
  async function peek(): Promise<string> {
    while (cursor === page.length && !ended) {
      if (offset === ref.encodedBytes) { page = decoder.decode(); cursor = 0; ended = true; break }
      const length = Math.min(32768, ref.encodedBytes - offset)
      page = decoder.decode(await readVerifiedArtifactBytes(root, directory, ref, offset, length, io), { stream: true }); cursor = 0; offset += length
    }
    return cursor === page.length ? '' : String.fromCodePoint(page.codePointAt(cursor)!)
  }
  async function take(): Promise<string> { const char = await peek(); cursor += char.length; return char }
  async function whitespace(): Promise<void> { while ([' ', '\r', '\n', '\t'].includes(await peek())) await take() }
  async function expect(char: string): Promise<void> { await whitespace(); if (await take() !== char) throw new Error('Invalid dependency catalog JSON') }
  async function value(): Promise<unknown> {
    await whitespace()
    let text = '', encoded = 0, depth = 0, quoted = false, escaped = false
    while (true) {
      const char = await peek()
      if (!char || !quoted && depth === 0 && ([':', ',', '}', ']', ' ', '\r', '\n', '\t'].includes(char))) break
      encoded += Buffer.byteLength(char)
      if (encoded > 8192) throw new Error('Dependency catalog descriptor exceeds limit')
      text += await take()
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') { quoted = false; if (depth === 0) break } }
      else if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') { depth--; if (depth === 0) break }
    }
    return parseDescriptor(text)
  }
  const keys = new Set<string>(), sourceIds = new Set<string>()
  let count = 0
  await expect('{')
  while (true) {
    const key = await value()
    if (typeof key !== 'string' || !['version', 'kind', 'entries'].includes(key) || keys.has(key)) throw new Error('Dependency catalog schema conflict')
    keys.add(key); await expect(':')
    if (key === 'entries') {
      await expect('['); await whitespace()
      if (await peek() !== ']') {
        while (true) {
          // JSON string encoding preserves distinct escaped lone surrogates;
          // raw UTF8 hashing would replace each with U+FFFD and collapse IDs.
          const entry = dependencyEntries([await value() as ResultDependency])[0]!, sourceHash = sha(JSON.stringify(entry.sourceId))
          if (sourceIds.has(sourceHash)) throw new Error('Duplicate dependency sourceId')
          sourceIds.add(sourceHash); await visit(entry, count++)
          await whitespace(); if (await peek() !== ',') break
          await take()
        }
      }
      await expect(']')
    } else if (await value() !== (key === 'version' ? 1 : 'result-dependencies')) throw new Error('Dependency catalog schema conflict')
    await whitespace(); if (await peek() !== ',') break
    await take()
  }
  await expect('}'); await whitespace()
  if (await peek() !== '' || keys.size !== 3 || expectedCount !== undefined && count !== expectedCount) throw new Error('Dependency catalog count or EOF conflict')
  return count
}
