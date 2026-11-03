import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createDesktopExecution } from '../src/execution.ts'
import { recordFixture } from './managed-fixture.ts'

it('projects a saved Code Mode envelope and its original reference without creating an execution assembly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-cold-projection-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'saved' })
  const document = await coordinator.openManagedDocument('saved')
  const ref = { version: 1 as const, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'json-utf8-v1' as const, encodedBytes: 1048578, contentDigest: 'c'.repeat(64), completeness: 'complete' as const }
  await recordFixture(document, { type: 'code/cell', cellId: 'original', sessionId: 'saved', state: 'completed' })
  await recordFixture(document, { type: 'code/output', cellId: 'original', envelope: { version: 1, execution: { outcome: 'unknown', dispatch: 'not-dispatched' }, preview: 'original preview', media: [], retention: { kind: 'artifact', ref } } })
  await coordinator.flush('saved')
  const service = createSessionService({ workspace: root, modelPolicy: 'required' })
  try {
    const result = await createDesktopExecution(coordinator, service).read('saved')
    expect(result.cells[0]).toMatchObject({ live: false, canTerminate: false, status: 'completed' })
    const output = JSON.parse(result.cells[0]!.output[0]!.text)
    expect(output).toEqual({ preview: 'original preview', retention: { kind: 'artifact', ref } })
    expect(service.hasAssembly('saved')).toBe(false)
  } finally { await service.close(); await coordinator.close() }
})
