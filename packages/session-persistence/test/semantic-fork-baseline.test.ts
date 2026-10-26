import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, forkSession } from '../src/index.ts'

// FC04: semantic records require the actual persisted readiness header.
it('fork archives only the current summary and typed tail, without consumed proof bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-semantic-fork-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const source = createSession()
    append(source, { type: 'turn/start' })
    append(source, { type: 'user/message', text: 'old' })
    append(source, { type: 'step/start' })
    append(source, { type: 'tool/call', callId: 'read', name: 'read', args: {} })
    append(source, { type: 'assistant/message', text: '' })
    append(source, { type: 'tool/dispatch', callId: 'read', eventSeq: 3 })
    append(source, { type: 'tool/result', callId: 'read', name: 'read', output: 'CONSUMED-PROOF-ONLY' + 'x'.repeat(4096) })
    append(source, { type: 'step/end' })
    append(source, { type: 'turn/end' })
    append(source, { type: 'compaction/replacement', version: 1, replacementId: 'twelve', text: 'summary twelve',
      coverage: [
        { item: { kind: 'input', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] },
        { item: { kind: 'exchange', at: { seq: 3, part: 'call' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'call' }, { seq: 4, part: 'message' }, { seq: 5, part: 'dispatch' }, { seq: 6, part: 'result' }] },
      ], insertBefore: { kind: 'input', at: { seq: 1, part: 'message' } } })
    append(source, { type: 'turn/start' })
    append(source, { type: 'user/message', text: 'tail' })
    append(source, { type: 'assistant/message', text: 'tail answer' })
    append(source, { type: 'turn/end' })
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.append('parent', source.events)
    const forked = await forkSession(coordinator, 'parent')
    if (!('sessionId' in forked)) throw new Error('fork did not return a ready target')
    const child = await backend.read(forked.sessionId)
    if (!child.meta) throw new Error('missing actual child metadata')
    expect(deriveMessages({ formatVersion: child.version, events: child.events, header: child.meta }).map(message => message.content)).toEqual(['summary twelve', 'tail', 'tail answer'])
    expect(child.events[0]).toMatchObject({ type: 'conversation/seed-manifest', seq: 0 })
    expect(child.events.at(-1)).toMatchObject({ type: 'session/bootstrap', seedLength: forked.seedLength, operationId: forked.operation.invocation.operationId })
    expect(child.meta.semanticSeed).toMatchObject({ operationId: forked.operation.invocation.operationId, seedLength: forked.seedLength })
    expect(JSON.stringify(child.events)).not.toContain('CONSUMED-PROOF-ONLY')
  } finally {
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
