import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch, deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig } from './fixtures/history.ts'
it('commits a positional replacement through the one managed writer and agrees with cold replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c3-compact-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(); await coordinator.append(id, history().events)
  const document = await coordinator.openManagedDocument(id), frames: string[][] = [], actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { frames.push(decodeFactBatch(args[3].bytes).events.map(event => event.type)); return actual(...args) }
  try {
    const result = await createCompactionHarness({ model: spyModel().model, factOwner: document, config: autoConfig }).compact(document.view)
    expect(result).toMatchObject({ compacted: true, outcome: 'ready', publication: 'committed' })
    expect(frames).toEqual([['compaction/replacement']])
    const cold = await backend.read(id); expect(deriveMessages({formatVersion:cold.version,events:cold.events})).toEqual(deriveMessages(document.view))
  } finally { await coordinator.close() }
})
it('managed view without a matching reduction capability never falls back to memory publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c3-missing-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(); await coordinator.append(id, history().events)
  const document = await coordinator.openManagedDocument(id), before = document.view.events.length
  try {
    const f=spyModel()
    expect(await createCompactionHarness({ model: f.model, config: autoConfig }).compact(document.view)).toMatchObject({ compacted: false, publication: 'none', blockedReason: 'publication-unavailable' })
    expect(f.requests).toEqual([])
    expect(document.view.events).toHaveLength(before)
  } finally { await coordinator.close() }
})
