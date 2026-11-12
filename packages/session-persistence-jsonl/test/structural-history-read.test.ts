import { expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CURRENT_FORMAT_VERSION, decodeFactBatch, encodeFactBatch, projectConversation, toJSONL } from '@i-harness/core-session'
import { createReadOnlySessionCoordinator, createSessionCoordinator, type SessionMeta } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { literalReady } from '../../core-session/test/fixtures/format11-seed.ts'

it.each([11, 12, 13, 14])('reads complete structural semantic history at format%s without minting native birth authority', async format => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'logical-history-')), id = 'literal-' + format, path = join(root, id + '.jsonl')
  const header: SessionMeta = { ...literalReady.header, formatVersion: format, sessionId: id, createdAt: '2026-10-22T00:00:00.000Z' }
  const exported = toJSONL({ ...literalReady, formatVersion: format, header })
  const records = exported.trimEnd().split('\n')
  expect(records).toHaveLength(2)
  expect(JSON.parse(records[1]!).batchId).toBe('structural-export')
  await writeFile(path, exported)
  await writeFile(path + '.publishing', '')
  const backend = createJsonlBackend(root), reader = createReadOnlySessionCoordinator(backend)
  try {
    const inventory = await readdir(root), before = await readFile(path)
    const loaded = await backend.read(id)
    expect(loaded.version).toBe(format); expect(loaded.events).toEqual(literalReady.events)
    const snapshot = await reader.snapshot(id)
    expect(snapshot.session.formatVersion).toBe(CURRENT_FORMAT_VERSION)
    expect(snapshot.session.events).toEqual(literalReady.events)
    expect(projectConversation(snapshot.session).items).toHaveLength(2)
    expect((await reader.profile(id)).meta.semanticSeed).toEqual(literalReady.header!.semanticSeed)
    expect(await readdir(root)).toEqual(inventory); expect(await readFile(path)).toEqual(before)
    expect('openManagedDocument' in reader).toBe(false)
    expect(await reader.list()).not.toContain(id)
    await expect(backend.bootstrapRoutes!.resolveBirth(id)).rejects.toThrow()
    const writer = createSessionCoordinator(backend, { lock: { enabled: true } })
    try {
      await expect(writer.openManagedDocument(id)).rejects.toThrow()
      expect(await readFile(path)).toEqual(before)
    } finally { await writer.close() }
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['header-only', 'seed-only', 'torn', 'corrupt', 'foreign-native-namespace', 'malformed-native-namespace'] as const)('refuses %s instead of salvaging structural history or native proof', async kind => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'logical-history-denial-')), id = 'literal', path = join(root, id + '.jsonl')
  const header: SessionMeta = { ...literalReady.header, formatVersion: literalReady.formatVersion, sessionId: id, createdAt: '2026-10-22T00:00:00.000Z' }
  const exported = toJSONL({ ...literalReady, header })
  let bytes = exported
  if (kind === 'header-only') bytes = exported.slice(0, exported.indexOf('\n') + 1)
  else if (kind === 'seed-only') {
    const header = exported.slice(0, exported.indexOf('\n') + 1), meta = JSON.parse(header)
    bytes = header + Buffer.from(encodeFactBatch('structural-export', meta.journal.legacyPrefixDigest, literalReady.events.slice(0, -1)).bytes).toString('utf8')
  }
  else if (kind === 'torn') bytes = exported.slice(0, -12)
  else if (kind === 'corrupt') bytes = exported.replace('seed exact', 'seed WRONG')
  await writeFile(path, bytes)
  if (kind === 'foreign-native-namespace') {
    // Complete logical data and even native-looking keys are insufficient:
    // the actual original stage is still required for a native namespace.
    const header = exported.slice(0, exported.indexOf('\n') + 1), meta = JSON.parse(header)
    const first = encodeFactBatch('bootstrap:literal:seed', meta.journal.legacyPrefixDigest, literalReady.events.slice(0, 2))
    const complete = encodeFactBatch('bootstrap:literal:complete', decodeFactBatch(first.bytes).prefixDigest, literalReady.events.slice(2))
    bytes = header + Buffer.concat([Buffer.from(first.bytes), Buffer.from(complete.bytes)]).toString('utf8')
    await writeFile(path, bytes)
    await writeFile(path + '.bootstrap-' + 'a'.repeat(64) + '.stage', '{"foreign":true}\n')
  } else if (kind === 'malformed-native-namespace') await writeFile(path + '.bootstrap-unknown.stage', '{}\n')
  const backend = createJsonlBackend(root), reader = createReadOnlySessionCoordinator(backend)
  try {
    const before = await readFile(path), names = await readdir(root)
    await expect(backend.read(id)).rejects.toThrow()
    await expect(reader.snapshot(id)).rejects.toThrow()
    expect(await readFile(path)).toEqual(before); expect(await readdir(root)).toEqual(names)
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }) }
})
it.each([6, 7, 8, 9, 10, 11, 12, 13, 14])('preserves actual format%s structural journal bytes through readonly inspection', async format => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'logical-journal-')), id = 'ordinary', path = join(root, id + '.jsonl')
  const events = [{ type: 'user/message' as const, seq: 0, text: 'original journal format ' + format }]
  const header: SessionMeta = { formatVersion: format, sessionId: id, createdAt: '2026-10-22T00:00:00.000Z' }
  const bytes = toJSONL({ formatVersion: format, events, header })
  await writeFile(path, bytes)
  const reader = createReadOnlySessionCoordinator(createJsonlBackend(root))
  try { expect((await reader.snapshot(id)).session.events).toEqual(events); expect(await readFile(path, 'utf8')).toBe(bytes) }
  finally { await reader.close(); await rm(root, { recursive: true, force: true }) }
})
