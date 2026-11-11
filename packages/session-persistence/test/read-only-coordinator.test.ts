import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createReadOnlySessionCoordinator } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { serializeHeader } from '../../session-persistence-jsonl/src/format.ts'
import { legacyPrefixDigest } from '@i-harness/core-session'

it('reads the original current prefix while a writer owns it, exposes no mutations, and preserves old artifacts', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'readonly-coordinator-'))
  const writer = createSessionCoordinator(createJsonlBackend(root))
  const reader = createReadOnlySessionCoordinator(createJsonlBackend(root), { lock: { enabled: false } })
  try {
    await writer.create({ sessionId: 'current' })
    await writer.putDocument('navigation', { current: 'original' })
    const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const }
    const old = { formatVersion: 13, sessionId: 'old', createdAt: '2026-01-01T00:00:00.000Z', journal, title: 'preserved legacy title' }
    await writeFile(join(root, 'old.jsonl'), serializeHeader(old) + '\n')
    const beforeCurrent = await readFile(join(root, 'current.jsonl')), beforeOld = await readFile(join(root, 'old.jsonl'))
    expect(reader.access).toBe('read')
    expect(Object.isFrozen(reader)).toBe(true)
    for (const method of ['create', 'append', 'patchMeta', 'adoptOwnership', 'openManagedDocument', 'putDocument']) expect(method in reader).toBe(false)
    expect(await reader.list()).toEqual(expect.arrayContaining(['current', 'old']))
    expect((await reader.profile('old')).meta).toMatchObject({ formatVersion: 13, title: 'preserved legacy title' })
    expect((await reader.snapshot('current')).session.events).toEqual([])
    expect((await reader.snapshot('old')).session.events).toEqual([])
    expect(await reader.getDocument('navigation')).toEqual({ current: 'original' })
    expect(await readFile(join(root, 'current.jsonl'))).toEqual(beforeCurrent)
    expect(await readFile(join(root, 'old.jsonl'))).toEqual(beforeOld)
    await reader.close(); await reader.close()
  } finally {
    await reader.close(); await writer.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
