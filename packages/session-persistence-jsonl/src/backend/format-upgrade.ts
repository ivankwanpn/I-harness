import { createReadStream } from 'node:fs'
import { open, rename, unlink, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionMeta } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { stageOwnedSessionFile } from './session-io.ts'
import type { StageLookupIO } from './bootstrap-stage.ts'
import { preserveBootstrapBirth } from './fact-journal.ts'
import { validateSemanticBootstrapHistory, readFactJournal, legacyPrefixDigest, CURRENT_FORMAT_VERSION } from '@i-harness/core-session'

/** Retained original upgrade candidate, for a fully observed ordinary parent. */
export async function stageOwnedUpgrade(path: string, raw: Buffer, identity: { dev: bigint; ino: bigint }, guard: () => void, verifyRoot: () => Promise<void>, stageIO?: StageLookupIO) {
  guard()
  const end = raw.indexOf(10); if (end < 0) throw new TypeError('Invalid legacy header')
  const line = raw.subarray(0, end).toString('utf8'), rawHeader = JSON.parse(line) as Record<string, unknown>, old = parseHeader(line)
  if (!Number.isSafeInteger(old.formatVersion) || old.formatVersion < 1 || old.formatVersion >= CURRENT_FORMAT_VERSION) throw new TypeError('Unsupported retained upgrade')
  const body = raw.subarray(end + 1)
  let meta: SessionMeta, separator = 0
  if (old.formatVersion >= 6) {
    const decoded = readFactJournal(body, old.journal!, old.formatVersion, old)
    if (decoded.torn || decoded.prefix.bodyBytes !== body.length) throw new TypeError('Incomplete predecessor journal')
    if (old.semanticSeed) { await preserveBootstrapBirth(path,raw,old,decoded.events,stageIO); guard() }
    meta = { ...rawHeader, formatVersion: CURRENT_FORMAT_VERSION } as SessionMeta
  } else {
    const lines = body.toString('utf8').split('\n').filter(value => value.trim())
    for (const value of lines) JSON.parse(value)
    separator = body.length > 0 && body.at(-1) !== 10 ? 1 : 0
    const journal = { version: 1 as const, legacyBodyBytes: body.length, legacyEventCount: lines.length, legacyPrefixDigest: legacyPrefixDigest(lines.length, body), separatorBytes: separator as 0 | 1 }
    meta = { ...rawHeader, ...old, modelSelection: rawHeader.modelSelection, formatVersion: CURRENT_FORMAT_VERSION, journal } as SessionMeta
  }
  const candidate = Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n'), body, ...(separator ? [Buffer.from('\n')] : [])])
  return stageOwnedSessionFile(path, candidate, guard, verifyRoot, { bytes: raw, identity })
}
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
  if (old.formatVersion !== expected || !Number.isSafeInteger(expected) || expected < 1 || expected >= CURRENT_FORMAT_VERSION) throw new TypeError('Unexpected journal upgrade')
  // The old physical profile must accept its own body before a header can
  // make newly required records readable under the current profile.
  if ([6,7,8,9,10,11,12].includes(old.formatVersion)) {
    const raw=await readFile(path)
    readFactJournal(raw.subarray(bodyStart),old.journal!,old.formatVersion,old)
  }
  if ([11,12].includes(old.formatVersion) && old.semanticSeed) {
    const raw = await readFile(path), decoded = readFactJournal(raw.subarray(bodyStart), old.journal!, old.formatVersion, old)
    if (decoded.torn) throw new TypeError('Cannot upgrade an incomplete bootstrap journal')
    validateSemanticBootstrapHistory(decoded.events, old.formatVersion, old)
    await preserveBootstrapBirth(path, raw, old, decoded.events)
    // The existing writable lane confirms the immutable birth before replacing
    // its current header. No initial input or bootstrap frame is issued again.
    const confirmed = await open(path, 'r+')
    try { await confirmed.sync() } finally { await confirmed.close() }
  }
  // Framed format6 already owns its exact legacy boundary and frame chain.
  // Only the header changes; never count frames as legacy event records.
  if ([6, 7, 8, 9, 10, 11, 12].includes(old.formatVersion)) return copyWithHeader(path, bodyStart, { ...rawHeader, formatVersion: CURRENT_FORMAT_VERSION } as SessionMeta)
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
