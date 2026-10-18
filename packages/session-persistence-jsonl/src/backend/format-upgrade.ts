import { createReadStream } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionMeta } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'

/** A one-time streamed header migration. The legacy body is byte-identical;
 * only a necessary separator LF is outside its hashed legacy boundary. */
export async function upgradeFactJournal(path: string, expected: number): Promise<SessionMeta> {
  const source = await open(path, 'r')
  let bodyStart: number, old: SessionMeta, rawHeader: Record<string, unknown>
  try {
    const header = Buffer.alloc(64 * 1024)
    const { bytesRead } = await source.read(header, 0, header.length, 0)
    const end = header.subarray(0, bytesRead).indexOf(0x0a)
    if (end < 0) throw new TypeError('Invalid legacy header')
    bodyStart = end + 1
    old = parseHeader(header.subarray(0, end).toString('utf8'))
    rawHeader = JSON.parse(header.subarray(0, end).toString('utf8'))
  } finally { await source.close() }
  if (old.formatVersion === CURRENT_FORMAT_VERSION) return old
  if (old.formatVersion !== expected || expected < 1 || expected > 7) throw new TypeError('Unexpected journal upgrade')
  // Framed format6 already owns its exact legacy boundary and frame chain.
  // Only the header changes; never count frames as legacy event records.
  if ([6, 7, 8].includes(old.formatVersion)) return copyWithHeader(path, bodyStart, { ...rawHeader, formatVersion: CURRENT_FORMAT_VERSION } as SessionMeta)
  let legacyBodyBytes = 0, legacyEventCount = 0, last = 0x0a, line = ''
  const decoder = new StringDecoder('utf8')
  const consume = (text: string) => {
    line += text
    let end: number
    while ((end = line.indexOf('\n')) >= 0) {
      if (line.slice(0, end).trim()) legacyEventCount++
      line = line.slice(end + 1)
    }
  }
  for await (const chunk of createReadStream(path, { start: bodyStart })) {
    const bytes = chunk as Buffer
    legacyBodyBytes += bytes.length
    last = bytes.at(-1) ?? last
    consume(decoder.write(bytes))
  }
  consume(decoder.end())
  if (line.trim()) legacyEventCount++
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(legacyEventCount))
  const digest = createHash('sha256').update('ih.fact-legacy.v1\0').update(count)
  for await (const chunk of createReadStream(path, { start: bodyStart })) digest.update(chunk as Buffer)
  const separatorBytes = legacyBodyBytes > 0 && last !== 0x0a ? 1 : 0
  const journal = { version: 1 as const, legacyBodyBytes, legacyEventCount, legacyPrefixDigest: digest.digest('hex'), separatorBytes: separatorBytes as 0 | 1 }
  const meta = { ...rawHeader, ...old, modelSelection: rawHeader.modelSelection, formatVersion: CURRENT_FORMAT_VERSION, journal } as SessionMeta
  return copyWithHeader(path, bodyStart, meta, separatorBytes)
}

async function copyWithHeader(path: string, bodyStart: number, meta: SessionMeta, separatorBytes = 0): Promise<SessionMeta> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const target = await open(temporary, 'wx')
  try {
    await target.writeFile(JSON.stringify(meta) + '\n')
    for await (const chunk of createReadStream(path, { start: bodyStart })) await target.writeFile(chunk)
    if (separatorBytes) await target.writeFile('\n')
    await target.sync()
  } catch (error) {
    await target.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  await target.close()
  try { await rename(temporary, path) }
  catch (error) { await unlink(temporary).catch(() => {}); throw error }
  const directory = await open(dirname(path), 'r').catch(() => undefined)
  if (directory) { try { await directory.sync() } catch { /* current Windows-qualified semantics */ } finally { await directory.close().catch(() => {}) } }
  return meta
}
