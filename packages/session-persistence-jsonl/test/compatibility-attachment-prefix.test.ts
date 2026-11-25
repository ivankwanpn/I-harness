import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { encodeFactBatch, readFactJournal, type JournalMetadata } from '@i-harness/core-session'
import { acquireRestoredContext } from '../../session-persistence/src/restored-context-internal.ts'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'

const betweenReaders = vi.hoisted(() => ({ replace: undefined as ((id: string, incarnation: string) => Promise<void>) | undefined }))
vi.mock('../src/backend/fact-journal.ts', async load => {
  const original = await load<typeof import('../src/backend/fact-journal.ts')>()
  return {
    ...original,
    createFactJournalBackend(...args: Parameters<typeof original.createFactJournalBackend>) {
      const journal = original.createFactJournalBackend(...args)
      return {
        ...journal,
        async readJournalPrefix(...args: Parameters<typeof journal.readJournalPrefix>) {
          await betweenReaders.replace?.(args[0], args[1].owner.incarnation)
          return journal.readJournalPrefix(...args)
        },
      }
    },
  }
})

it.each([
  { name: 'cold document', incarnation: 'cold-recovery', restore: false },
  { name: 'existing restored reader', incarnation: 'restored-compatibility', restore: true },
])('refuses a different same-length prefix and reloads the $name', async ({ incarnation, restore }) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-attach-prefix-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    const { id } = await coordinator.create()
    const path = join(root, id + '.jsonl')
    const source = await readFile(path)
    const headerEnd = source.indexOf(10)
    const header = source.subarray(0, headerEnd + 1)
    const meta = JSON.parse(header.toString('utf8')) as { journal: JournalMetadata; formatVersion: number; sessionId: string }
    const frame = (text: string) => encodeFactBatch('fixture', meta.journal.legacyPrefixDigest, [{ type: 'user/message', text, seq: 0 }]).bytes
    const before = frame('before'), replacement = frame('after!')
    const observed = (body: Uint8Array) => readFactJournal(body, meta.journal, meta.formatVersion, meta).prefix
    expect(observed(before)).toMatchObject({ eventCount: 1, bodyBytes: observed(replacement).bodyBytes })
    expect(observed(before).prefixDigest).not.toBe(observed(replacement).prefixDigest)
    await writeFile(path, Buffer.concat([header, before]))
    expect(Object.keys(await coordinator.loadOwned(id))).toEqual(['session'])
    const restored = restore ? await acquireRestoredContext(coordinator, id) : undefined

    let replacements = 0
    const replaceAtNextWriter = (value: Uint8Array) => {
      betweenReaders.replace = async (opening, owner) => {
        if (opening !== id || owner !== incarnation) return
        betweenReaders.replace = undefined
        await writeFile(path, Buffer.concat([header, value]))
        replacements++
      }
    }
    replaceAtNextWriter(replacement)
    const attempts = await Promise.allSettled([coordinator.openManagedDocument(id), coordinator.openManagedDocument(id)])
    const reasons = attempts.map(attempt => {
      if (attempt.status !== 'rejected') throw Error('Stale view was attached')
      return attempt.reason
    })
    expect(reasons).toContainEqual(expect.objectContaining({ message: 'Managed recovery archive mismatch' }))
    for (const reason of reasons) {
      // Concurrent callers can be rejected by the public admission fence
      // before joining the same underlying opening operation.
      if (reason.message !== 'Managed recovery archive mismatch') expect(reason).toMatchObject({
        name: 'SessionBindingObservationError', reason: 'conflict', code: 'FACT_RECOVERY_REQUIRED',
      })
    }
    expect(replacements).toBe(1)
    expect(await readFile(path)).toEqual(Buffer.concat([header, replacement]))

    // The next open retires the stale restored reader before checking the
    // writer. A second change must still leave a usable opening registry.
    const latest = restored ? 'newest' : 'after!'
    if (restored) {
      replaceAtNextWriter(frame(latest))
      await expect(coordinator.openManagedDocument(id)).rejects.toThrow('Managed recovery archive mismatch')
      expect(replacements).toBe(2)
    }
    const reopened = await coordinator.openManagedDocument(id)
    expect(reopened.view.events).toEqual([{ type: 'user/message', seq: 0, text: latest }])
    expect((await reopened.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    const persisted = (await readFile(path)).subarray(headerEnd + 1)
    expect(readFactJournal(persisted, meta.journal, meta.formatVersion, meta).events[0]).toEqual(reopened.view.events[0])
    if (restored) {
      await expect(restored.prepare()).rejects.toThrow()
      await restored.close()
      expect(await coordinator.openManagedDocument(id)).toBe(reopened)
    }
  } finally {
    betweenReaders.replace = undefined
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
