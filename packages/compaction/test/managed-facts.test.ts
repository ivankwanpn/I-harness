import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { createCompactionEngine } from '../src/index.ts'

it('commits existing summary markers as one ordinary managed group before publishing reduction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-compact-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  await coordinator.append(id, [{ type: 'user/message', text: 'word '.repeat(80), seq: 0 }])
  const document = await coordinator.openManagedDocument(id), frames: string[][] = []
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { frames.push(decodeFactBatch(args[3].bytes).events.map(event => event.type)); return actual(...args) }
  try {
    const engine = createCompactionEngine({ facts: () => document.compaction, config: { contextWindow: 10000, thresholdRatio: .05, maxTokens: 200 }, model: { async *stream() {
      yield { type: 'text/chunk', text: '## Primary Request and Intent\n- ' + 'work '.repeat(120) }
      yield { type: 'end' }
    } } } as any)
    expect((await engine.compact(document.view as any)).compacted).toBe(true)
    expect(frames).toEqual([['compaction/start', 'compaction/summary', 'compaction/end']])
    expect((await backend.read(id)).events.slice(1).map(event => event.seq)).toEqual([1, 2, 3])
  } finally { await coordinator.close() }
})
