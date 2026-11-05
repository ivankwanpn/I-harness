import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION, type SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-commit-dual-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })

const corpus: { id: string; title?: string; events: SessionEvent[] }[] = [
  { id: 'empty', events: [] },
  { id: 'message', events: [{ type: 'user/message', text: 'hello', seq: 0 }] },
  { id: 'turn', title: 'A turn', events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'question', seq: 1 },
    { type: 'assistant/message', text: 'answer', seq: 2 }, { type: 'turn/end', seq: 3 },
  ] },
  { id: 'internal', events: [
    { type: 'user/message', text: 'hidden', internal: true, seq: 0 },
    { type: 'user/message', text: 'shown', seq: 1 },
  ] },
  { id: 'tools', events: [
    { type: 'turn/start', seq: 0 },
    { type: 'tool/call', callId: 'c1', name: 'read', args: { path: 'a.txt' }, seq: 1 },
    { type: 'tool/result', callId: 'c1', name: 'read', output: { content: 'done' }, seq: 2 },
    { type: 'turn/end', seq: 3 },
  ] },
  { id: 'steps', events: [
    { type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'assistant/message', text: 'working', seq: 2 }, { type: 'step/end', seq: 3 }, { type: 'turn/end', seq: 4 },
  ] },
  { id: 'two-turns', events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'one', seq: 1 }, { type: 'assistant/message', text: 'two', seq: 2 }, { type: 'turn/end', seq: 3 },
    { type: 'turn/start', seq: 4 }, { type: 'user/message', text: 'three', seq: 5 }, { type: 'assistant/message', text: 'four', seq: 6 }, { type: 'turn/end', seq: 7 },
  ] },
]

describe('commit-log dual run over a legacy corpus', () => {
  it('reads the same events and documents as the JSONL backend', async () => {
    const base = await root()
    const backend = createJsonlBackend(base)
    for (const entry of corpus) {
      await backend.create(entry.id, { sessionId: entry.id, createdAt: '2026-01-01T00:00:00.000Z', formatVersion: CURRENT_FORMAT_VERSION, ...(entry.title === undefined ? {} : { title: entry.title }) })
      if (entry.events.length) await backend.append(entry.id, entry.events)
    }
    await backend.putDocument('task-task', { formatVersion: 2, tasks: [], notifications: [] })
    const coordinator = createJsonlCommitCoordinator(base)
    try {
      expect(await coordinator.list()).toEqual(await backend.list())
      for (const entry of corpus) {
        const raw = await backend.read(entry.id)
        const loaded = await coordinator.load(entry.id)
        expect(loaded.session.events).toEqual(raw.events)
        if (entry.title !== undefined) expect((await coordinator.profile(entry.id)).meta.title).toBe(entry.title)
      }
      expect(await coordinator.getDocument('task-task')).toEqual(await backend.getDocument('task-task'))
    } finally { await coordinator.close() }
  })
})