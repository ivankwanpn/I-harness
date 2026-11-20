import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createSelectedResultsOperation, readSelectedResultsPrepareResult } from '@i-harness/sdk'
import {
  SELECTED_RESULTS_HEADER, createSelectedResultsHostFixture, executeSelected, forkSelected, seedManagedRows, storedSession,
} from './helpers/selected-results-host.ts'

/** The source turn must really execute the read tool: the model scripts one
 *  registry-dispatched call, and the fork must hand the target the exact
 *  retained bytes of that call's saved result. */
it('forks a real tool turn and keeps its selected result readable on the child', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    // Two model exchanges: the tool call and the answer after the tool result.
    expect(client.stats).toMatchObject({ modelCalls: 2, toolCalls: 1 })

    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    // The tool ran once through the real registry: one call, one dispatch, one
    // artifact result. A model branch that did not execute the tool would fail
    // these assertions instead of silently forking an empty selection.
    expect(source.events.filter(event => event.type === 'tool/call' && (event as { name?: string }).name === 'read')).toHaveLength(1)
    expect(source.events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(source.artifactResultCount).toBe(1)
    expect(source.results).toHaveLength(1)
    const saved = source.results[0]!

    const before = await client.readAll(sourceSessionId, saved.ref)
    expect(before.text.includes(SELECTED_RESULTS_HEADER)).toBe(true)
    expect(before.pages).toBeGreaterThan(1)
    expect(before.bytes).toBe(saved.ref.encodedBytes)
    expect(createHash('sha256').update(Buffer.from(before.text, 'utf8')).digest('hex')).toBe(saved.ref.contentDigest)

    const title = 'Retained output'
    const request = { version: 2, sourceSessionId, results: 'selected-results-v1', metadata: { title } } as const
    const response = readSelectedResultsPrepareResult(await client.call('session/fork/results/prepare', request), request)
    if (response.kind !== 'prepared') throw Error('Selected-results preparation refused: ' + response.reason)
    const { prepared } = response
    const operation = createSelectedResultsOperation(prepared, {
      operationId: 'selected-fork', targetSessionId: 'selected-child', createdAt: new Date().toISOString(),
    })
    const begin = await executeSelected(client, operation)
    expect(prepared).toMatchObject({ version: 2, kind: 'session-fork-prepared', core: { sourceSessionId, results: 'selected-results-v1' } })
    expect(begin).toMatchObject({ kind: 'ready', capture: 'captured', sessionId: 'selected-child', title })
    expect(begin.receipt.results).toMatchObject({ version: 1, rows: 1, pages: 1 })

    const child = await storedSession(fixture.sessionDir, 'selected-child')
    expect(child.header.semanticSeed).toMatchObject({ version: 3, codec: 'semantic-seed-v3', operationId: 'selected-fork', requestDigest: prepared.requestDigest })
    const manifest = child.events[0] as { type: string; version: number; codec: string; results: unknown; resultPageCount: number; digest: string }
    expect(manifest).toMatchObject({ type: 'conversation/seed-manifest', version: 3, codec: 'semantic-seed-v3', resultPageCount: 1, results: begin.receipt.results })
    expect(manifest.digest).toBe(begin.receipt.seedDigest)
    expect(begin.seedLength).toBe(child.events.filter(event => ['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group'].includes(event.type)).length)
    const rows = seedManagedRows(child.events)
    expect(rows).toHaveLength(1)
    // The saved event (not a rebuilt or codec-shaped stand-in) is the source of
    // the reference: exact artifact identity and exact original address.
    expect(rows[0]!.ref).toEqual(saved.ref)
    expect(rows[0]!.original).toEqual({ kind: 'local', sessionId: sourceSessionId, seq: saved.seq, event: 'tool/result', slot: 'envelope.retention.ref' })

    const inherited = await client.readAll('selected-child', saved.ref)
    expect(inherited.text).toBe(before.text)
    expect(inherited.pages).toBe(before.pages)

    // A rewritten revision, a replaced identifier or altered content identity
    // must not read the retained bytes; the child's own query is what selects
    // the page and the host verifies the committed artifact identity.
    expect(await client.readPage('selected-child', { ...saved.ref, revision: 'c'.repeat(64) })).toMatchObject({ kind: 'unavailable' })
    expect(await client.readPage('selected-child', { ...saved.ref, id: 'ctxv1_' + 'd'.repeat(64) })).toMatchObject({ kind: 'unavailable' })
    expect(await client.readPage('selected-child', { ...saved.ref, contentDigest: 'e'.repeat(64) })).toMatchObject({ kind: 'unavailable' })

    // Retrying the same operation adopts the same durable child without a
    // second capture, model request, seed write or retention effect.
    const retried = await client.call('session/fork/results/retry', { operation }) as typeof begin
    expect(retried).toMatchObject({ kind: 'adopted', title })
    expect(retried.receipt).toEqual(begin.receipt)
    expect(client.stats).toMatchObject({ modelCalls: 2, toolCalls: 1 })
    const retriedChild = await storedSession(fixture.sessionDir, 'selected-child')
    expect(seedManagedRows(retriedChild.events)).toEqual(rows)

    // The target's retention is its own: archiving the source denies the source
    // but the child still reads the exact inherited bytes.
    await client.call('desktop/session/manage', { sessionId: sourceSessionId, action: 'archive' })
    expect(await client.readPage(sourceSessionId, saved.ref)).toMatchObject({ kind: 'unavailable' })
    expect((await client.readAll('selected-child', saved.ref)).text).toBe(before.text)

    await client.close()
    // Closing twice is idempotent: the host reports no retained cleanup debt.
    await client.close()
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

/** A source that already saved several results must carry every exact
 *  reference, and results produced after the fork stay outside the child. */
it('carries every saved result reference and excludes results produced after the fork', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big again' })
    expect(client.stats).toMatchObject({ toolCalls: 2 })

    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(source.results).toHaveLength(2)
    const texts = await Promise.all(source.results.map(result => client.readAll(sourceSessionId, result.ref)))
    expect(new Set(source.results.map(result => result.ref.id)).size).toBe(2)
    for (const text of texts) expect(text.text.includes(SELECTED_RESULTS_HEADER)).toBe(true)

    const { begin } = await forkSelected(client, sourceSessionId, 'multi-child', 'selected-multi')
    // One page per selected turn extent: both results stay exact and ordered.
    expect(begin.receipt.results).toMatchObject({ rows: 2, pages: 2 })
    const child = await storedSession(fixture.sessionDir, 'multi-child')
    const rows = seedManagedRows(child.events)
    expect(rows.map(row => row.ref)).toEqual(source.results.map(result => result.ref))
    for (const [index, result] of source.results.entries()) {
      expect((await client.readAll('multi-child', result.ref)).text).toBe(texts[index]!.text)
    }

    // A result created after the fork is not part of the child's selection even
    // though the child's parent keeps producing results.
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big after the fork' })
    const after = await storedSession(fixture.sessionDir, sourceSessionId)
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
}, 120000)
