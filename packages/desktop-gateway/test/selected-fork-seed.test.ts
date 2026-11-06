import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codecRef } from '../../core-session/test/fixtures/selected-results.ts'
import { createCommitCoordinator } from '../../session-persistence/src/commit/coordinator.ts'
import { asSessionCoordinator } from '../../session-persistence/src/commit/facade.ts'
import { captureSelectedResultsSeed } from '../src/selected-fork.ts'

it('builds the selected-results seed from a commit-log session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-seed-'))
  const coordinator = createCommitCoordinator({ root })
  try {
    const session = asSessionCoordinator(coordinator)
    await session.create({ sessionId: 's1' })
    await session.append('s1', [
      { type: 'turn/start' }, { type: 'step/start' },
      { type: 'tool/call', callId: 'c', name: 'read', args: {} },
      { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
      { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
      { type: 'step/end' }, { type: 'turn/end' },
    ] as never)
    const captured = await captureSelectedResultsSeed(session, 's1')
    expect(captured.kind).toBe('compiled')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    expect(captured.compiled.records[0]).toMatchObject({ type: 'conversation/seed-manifest', version: 3, codec: 'semantic-seed-v3' })
    expect(captured.compiled.dependencyDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
