import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bindProject, createSelectedResultsHostFixture, executeSelected, prepareSelected, storedSession } from './helpers/selected-results-host.ts'

const cut = vi.hoisted(() => ({
  failReceipt: false,
  receiptFailures: 0,
  originalReceipt: undefined as unknown,
  duplicatePublication: false,
  publications: [] as string[],
}))

vi.mock('@i-harness/session-persistence/internal/commit-facade', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/session-persistence/internal/commit-facade')>()
  return {
    ...actual,
    asSessionCoordinator(...args: Parameters<typeof actual.asSessionCoordinator>) {
      const coordinator = actual.asSessionCoordinator(...args)
      const putDocument = coordinator.putDocument.bind(coordinator)
      coordinator.putDocument = async (key, value) => {
        const state = value as { outcome?: { kind?: string; receipt?: unknown } } | undefined
        if (cut.failReceipt && key.startsWith('selected-fork-') && state?.outcome?.kind === 'ready') {
          cut.failReceipt = false
          cut.receiptFailures += 1
          cut.originalReceipt = state.outcome.receipt
          throw new Error('injected failure before saving fork outcome')
        }
        return putDocument(key, value)
      }
      const publish = coordinator.publishForkTarget!.bind(coordinator)
      coordinator.publishForkTarget = async target => {
        if (!cut.duplicatePublication) return publish(target)
        cut.duplicatePublication = false
        const results = await Promise.all([publish(target), publish(target)])
        cut.publications = results
        return results[0]!
      }
      return coordinator
    },
  }
})

it('recovers its published fork receipt after the source is archived and cleared', async () => {
  const fixture = await createSelectedResultsHostFixture()
  let client = await fixture.open()
  const target = 'review-committed-target'
  try {
    await client.call('initialize')
    const { sessionId: source } = await client.call('session/create') as { sessionId: string }
    await bindProject(client, source, fixture.project)
    await client.call('session/prompt', { sessionId: source, prompt: 'read big' })
    const sourceDoc = await storedSession(fixture.sessionDir, source)
    expect(sourceDoc.results).toHaveLength(1)
    const ref = sourceDoc.results[0]!.ref
    const originalResult = await client.readAll(source, ref)
    const { operation } = await prepareSelected(client, source, target, 'review-published-receipt')
    cut.receiptFailures = 0
    cut.originalReceipt = undefined
    cut.failReceipt = true
    await expect(executeSelected(client, operation)).rejects.toThrow('Session fork unavailable')
    expect(cut.receiptFailures).toBe(1)
    expect((await storedSession(fixture.sessionDir, target)).header).toMatchObject({ archived: false, forkPublication: 'published' })

    await client.call('desktop/session/manage', { sessionId: source, action: 'archive' })
    await client.call('desktop/context-subsystems/action', { command: { target: 'context', action: 'clear', sessionId: source } })
    expect(await client.readPage(source, ref)).toMatchObject({ kind: 'unavailable' })
    await client.close()
    client = await fixture.open()
    await client.call('initialize')
    await client.call('desktop/project/sync', { projects: [fixture.project] })
    expect(await client.call('desktop/session/project/state', { sessionId: target })).toMatchObject({ projectId: fixture.project.id })

    const replay = await executeSelected(client, operation, 'retry')
    console.info(JSON.stringify({ review: 'published receipt after source archive and clear', replay: replay.kind, reason: replay.reason, receiptFailures: cut.receiptFailures, exactReceipt: JSON.stringify(replay.receipt) === JSON.stringify(cut.originalReceipt) }))
    expect(['ready', 'adopted']).toContain(replay.kind)
    expect(replay).toMatchObject({ sessionId: target, receipt: cut.originalReceipt })
    expect(await client.readAll(target, ref)).toEqual(originalResult)
  } finally {
    cut.failReceipt = false
    try { await client.close() } finally { await fixture.dispose() }
  }
}, 120000)

it('serializes same-target publication at the real commit coordinator', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const { sessionId: source } = await client.call('session/create') as { sessionId: string }
    await client.call('session/prompt', { sessionId: source, prompt: 'read big' })
    expect((await storedSession(fixture.sessionDir, source)).results).toHaveLength(1)
    const target = 'review-single-publication'
    const { operation } = await prepareSelected(client, source, target, 'review-double-publication')
    cut.publications = []
    cut.duplicatePublication = true
    expect(await executeSelected(client, operation)).toMatchObject({ kind: 'ready' })
    const journal = await readFile(join(fixture.sessionDir, target, 'session.v15.jsonl'), 'utf8')
    const publishedRecords = journal.trimEnd().split('\n').map(line => JSON.parse(line) as { ops?: { kind?: string; patch?: { forkPublication?: string } }[] })
      .filter(record => record.ops?.some(op => op.kind === 'meta' && op.patch?.forkPublication === 'published')).length
    console.info(JSON.stringify({ review: 'coordinator concurrent publication', results: cut.publications, publishedRecords }))
    expect([...cut.publications].sort()).toEqual(['already-published', 'published'])
    expect(publishedRecords).toBe(1)
  } finally {
    cut.duplicatePublication = false
    try { await client.close() } finally { await fixture.dispose() }
  }
}, 120000)
