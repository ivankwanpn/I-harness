import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  SELECTED_RESULTS_HEADER, bindProject, createSelectedResultsHostFixture, executeSelected, forkSelected, prepareSelected,
  seedManagedRows, storedSession,
} from './helpers/selected-results-host.ts'

/** The JSONL host must expose the dedicated public `public-results-v1` route:
 *  a real tool turn produces a retained result, the selected fork carries the
 *  exact bytes to the child, and the child's own store reads them back. */
it('forks a real tool turn through the dedicated JSONL public route', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    expect(client.stats).toMatchObject({ modelCalls: 2, toolCalls: 1 })

    const source = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    expect(source.events.filter(event => event.type === 'tool/call' && (event as { name?: string }).name === 'read')).toHaveLength(1)
    expect(source.artifactResultCount).toBe(1)
    expect(source.results).toHaveLength(1)
    const saved = source.results[0]!

    const before = await client.readAll(sourceSessionId, saved.ref)
    expect(before.text.includes(SELECTED_RESULTS_HEADER)).toBe(true)
    expect(before.bytes).toBe(saved.ref.encodedBytes)
    expect(createHash('sha256').update(Buffer.from(before.text, 'utf8')).digest('hex')).toBe(saved.ref.contentDigest)

    const { prepared, operation, begin } = await forkSelected(client, sourceSessionId, 'selected-child', 'selected-fork')
    expect(prepared).toMatchObject({ version: 2, kind: 'session-fork-prepared', core: { sourceSessionId, results: 'selected-results-v1' } })
    expect(begin).toMatchObject({ kind: 'ready', capture: 'captured', sessionId: 'selected-child' })
    expect(begin.receipt.results).toMatchObject({ version: 1, rows: 1, pages: 1 })

    const child = await storedSession(fixture.sessionDir, 'selected-child', 'jsonl')
    expect(child.header.semanticSeed).toMatchObject({ version: 3, codec: 'semantic-seed-v3', operationId: 'selected-fork', requestDigest: prepared.requestDigest })
    const manifest = child.events[0] as { type: string; version: number; codec: string; results: unknown; resultPageCount: number; digest: string }
    expect(manifest).toMatchObject({ type: 'conversation/seed-manifest', version: 3, codec: 'semantic-seed-v3', resultPageCount: 1, results: begin.receipt.results })
    expect(manifest.digest).toBe(begin.receipt.seedDigest)
    expect(begin.seedLength).toBe(child.events.filter(event => ['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group'].includes(event.type)).length)
    const rows = seedManagedRows(child.events)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ref).toEqual(saved.ref)
    expect(rows[0]!.original).toEqual({ kind: 'local', sessionId: sourceSessionId, seq: saved.seq, event: 'tool/result', slot: 'envelope.retention.ref' })

    const inherited = await client.readAll('selected-child', saved.ref)
    expect(inherited.text).toBe(before.text)
    expect(inherited.pages).toBe(before.pages)

    // A rewritten revision, a replaced identifier or altered content identity
    // must not read the retained bytes.
    expect(await client.readPage('selected-child', { ...saved.ref, revision: 'c'.repeat(64) })).toMatchObject({ kind: 'unavailable' })
    expect(await client.readPage('selected-child', { ...saved.ref, id: 'ctxv1_' + 'd'.repeat(64) })).toMatchObject({ kind: 'unavailable' })
    expect(await client.readPage('selected-child', { ...saved.ref, contentDigest: 'e'.repeat(64) })).toMatchObject({ kind: 'unavailable' })

    // Retrying the same operation adopts the durable child and exact receipt
    // without a second capture, model request or publication effect.
    const childBytes = await readFile(join(fixture.sessionDir, 'selected-child.jsonl'))
    const retried = await client.call('session/fork/retry', { operation }) as typeof begin
    expect(retried.kind).toBe('adopted')
    expect(retried.receipt).toEqual(begin.receipt)
    expect(client.stats).toMatchObject({ modelCalls: 2, toolCalls: 1 })
    // Adoption writes nothing: the target's durable birth and suffix are exact.
    expect(await readFile(join(fixture.sessionDir, 'selected-child.jsonl'))).toEqual(childBytes)
    const retriedChild = await storedSession(fixture.sessionDir, 'selected-child', 'jsonl')
    expect(seedManagedRows(retriedChild.events)).toEqual(rows)

    // The target's retention is its own: archiving the source denies the source
    // but the child still reads the exact inherited bytes.
    await client.call('desktop/session/manage', { sessionId: sourceSessionId, action: 'archive' })
    expect(await client.readPage(sourceSessionId, saved.ref)).toMatchObject({ kind: 'unavailable' })
    expect((await client.readAll('selected-child', saved.ref)).text).toBe(before.text)

    await client.close()
    await client.close()
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)

/** A source that already saved several results must carry every exact
 *  reference, and results produced after the fork stay outside the child. */
it('carries every saved result reference and excludes results produced after the fork', async () => {  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big again' })
    expect(client.stats).toMatchObject({ toolCalls: 2 })

    const source = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    expect(source.results).toHaveLength(2)
    const texts = await Promise.all(source.results.map(result => client.readAll(sourceSessionId, result.ref)))
    expect(new Set(source.results.map(result => result.ref.id)).size).toBe(2)
    for (const text of texts) expect(text.text.includes(SELECTED_RESULTS_HEADER)).toBe(true)

    const { begin } = await forkSelected(client, sourceSessionId, 'multi-child', 'selected-multi')
    expect(begin.receipt.results).toMatchObject({ rows: 2, pages: 2 })
    const child = await storedSession(fixture.sessionDir, 'multi-child', 'jsonl')
    const rows = seedManagedRows(child.events)
    expect(rows.map(row => row.ref)).toEqual(source.results.map(result => result.ref))
    for (const [index, result] of source.results.entries()) {
      expect((await client.readAll('multi-child', result.ref)).text).toBe(texts[index]!.text)
    }

    // A result created after the fork is not part of the child's selection even
    // though the child's parent keeps producing results.
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big after the fork' })
    const after = await storedSession(fixture.sessionDir, sourceSessionId, 'jsonl')
    expect(after.results).toHaveLength(3)
    const future = after.results[2]!
    expect(rows.some(row => row.ref!.id === future.ref.id)).toBe(false)
    expect(await client.readPage('multi-child', future.ref)).toMatchObject({ kind: 'unavailable' })
    expect((await client.readAll(sourceSessionId, future.ref)).text.includes(SELECTED_RESULTS_HEADER)).toBe(true)

    await client.close()
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)


/** The prepared project intent is part of the operation identity: a source that
 *  moved between prepare and begin is refused honestly instead of forking into
 *  the old or new project. */
it('refuses a source project binding that changed between prepare and begin', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await bindProject(client, sourceSessionId, fixture.project)
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const { operation } = await prepareSelected(client, sourceSessionId, 'policy-child', 'policy-op')
    // The source is moved to a different real project before the begin.
    const other = { ...fixture.project, id: 'project-2', name: 'Second project' }
    await client.call('desktop/project/sync', { projects: [fixture.project, other] })
    const moved = await client.call('desktop/session/batch', { command: { action: 'move', sessionIds: [sourceSessionId], expectedOwners: { [sourceSessionId]: fixture.project.id }, projectId: other.id } }) as { results: { ok: boolean }[] }
    expect(moved.results[0]).toMatchObject({ ok: true })
    expect(await executeSelected(client, operation)).toMatchObject({ kind: 'not-issued', reason: 'policy' })
    // Moving it back lets the same operation proceed on its fresh capture.
    const movedBack = await client.call('desktop/session/batch', { command: { action: 'move', sessionIds: [sourceSessionId], expectedOwners: { [sourceSessionId]: other.id }, projectId: fixture.project.id } }) as { results: { ok: boolean }[] }
    expect(movedBack.results[0]).toMatchObject({ ok: true })
    const begun = await executeSelected(client, operation)
    expect(begun).toMatchObject({ kind: 'ready', sessionId: 'policy-child' })
    expect(await client.call('desktop/session/project/state', { sessionId: 'policy-child' })).toMatchObject({ projectId: fixture.project.id })
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)