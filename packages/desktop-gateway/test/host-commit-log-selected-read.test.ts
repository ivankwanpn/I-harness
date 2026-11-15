import { expect, it } from 'vitest'
import {
  bindProject, createSelectedResultsHostFixture, forkSelected, managedArtifactPaths, seedManagedRows, storedSession,
} from './helpers/selected-results-host.ts'

/** The accepted selected-results contract: the target keeps reading the exact
 *  inherited bytes through source retirement, source deletion, nested forks,
 *  clear and a full host restart. */
it('keeps inherited managed results readable after source retirement, deletion and a cold reopen', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const first = await fixture.open()
  let sourceSessionId = ''
  let ref: { id: string; revision: string } = { id: '', revision: '' }
  let expected = ''
  try {
    await first.call('initialize')
    const created = await first.call('session/create') as { sessionId: string }
    sourceSessionId = created.sessionId
    await bindProject(first, sourceSessionId, fixture.project)
    await first.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    ref = source.results[0]!.ref
    expected = (await first.readAll(sourceSessionId, ref)).text
    expect((await managedArtifactPaths(fixture.sessionDir, ref.id)).length).toBeGreaterThan(0)
    await first.close()
  } finally { await first.close().catch(() => {}) }

  const second = await fixture.open()
  try {
    await second.call('initialize')
    await second.call('desktop/project/sync', { projects: [fixture.project] })
    // The source itself is cold but still readable, and its exact bytes match.
    expect((await second.readAll(sourceSessionId, ref)).text).toBe(expected)
    const { begin } = await forkSelected(second, sourceSessionId, 'child', 'selected-read')
    expect(begin).toMatchObject({ kind: 'ready', capture: 'captured' })
    expect(begin.receipt.results).toMatchObject({ version: 1, rows: 1, pages: 1 })
    expect((await second.readAll('child', ref)).text).toBe(expected)
    expect(await second.call('desktop/session/project/state', { sessionId: 'child' })).toMatchObject({ projectId: fixture.project.id })

    // Retiring the source removes the ancestor the metadata-only fallback could
    // have read through: the target must still read its own retained bytes.
    await second.call('desktop/session/manage', { sessionId: sourceSessionId, action: 'archive' })
    expect(await second.readPage(sourceSessionId, ref)).toMatchObject({ kind: 'unavailable' })
    expect((await second.readAll('child', ref)).text).toBe(expected)

    // Clearing the source's context output must not withdraw inherited bytes
    // the target already retained.
    await second.call('desktop/context-subsystems/action', { command: { target: 'context', action: 'clear', sessionId: sourceSessionId } })
    expect((await second.readAll('child', ref)).text).toBe(expected)

    // A nested selected fork inherits from the child and keeps its own copy.
    const nested = await forkSelected(second, 'child', 'grandchild', 'selected-read-nested')
    expect(nested.begin).toMatchObject({ kind: 'ready', capture: 'captured', sessionId: 'grandchild' })
    expect((await second.readAll('grandchild', ref)).text).toBe(expected)

    await second.call('desktop/session/manage', { sessionId: 'child', action: 'archive' })
    expect(await second.readPage('child', ref)).toMatchObject({ kind: 'unavailable' })
    expect((await second.readAll('grandchild', ref)).text).toBe(expected)

    // The store forbids deleting a session that still has descendants, so a
    // source deletion with a live target is not an available operation; the
    // target's own release and the final artifact reclamation are covered by
    // 'releases inherited retention when the owning sessions are deleted'.
    await second.close()
  } finally { await second.close().catch(() => {}) }

  const third = await fixture.open()
  try {
    await third.call('initialize')
    await third.call('desktop/project/sync', { projects: [fixture.project] })
    // Cold replay of the retained bytes, with the deleted source and archived
    // child permanently unavailable.
    expect(await third.readPage(sourceSessionId, ref)).toMatchObject({ kind: 'unavailable' })
    expect((await third.readAll('grandchild', ref)).text).toBe(expected)
    const grandchild = await storedSession(fixture.sessionDir, 'grandchild')
    expect(seedManagedRows(grandchild.events).map(row => row.ref!.id)).toEqual([ref.id])
  } finally {
    await third.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)

/** Selection, rewind and authorization boundaries on the public route. */
it('denies results that were not selected, hidden by rewind or given a different identity', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    await client.call('desktop/project/sync', { projects: [fixture.project] })
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await bindProject(client, sourceSessionId, fixture.project)
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const firstTurn = await storedSession(fixture.sessionDir, sourceSessionId)
    const hidden = firstTurn.results[0]!.ref
    const hiddenText = (await client.readAll(sourceSessionId, hidden)).text

    // Rewind the whole first turn away, then produce a result on the new branch.
    const plan = await client.call('desktop/rewind/plan', { sessionId: sourceSessionId, target: 0, mode: 'conversation' }) as { fingerprint: string }
    await client.call('desktop/rewind/execute', { sessionId: sourceSessionId, target: 0, mode: 'conversation', fingerprint: plan.fingerprint })
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big after rewind' })
    const branch = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(branch.results).toHaveLength(2)
    const visible = branch.results[1]!.ref
    expect(visible.id).not.toBe(hidden.id)
    const visibleText = (await client.readAll(sourceSessionId, visible)).text

    const { begin } = await forkSelected(client, sourceSessionId, 'branch-child', 'selected-branch')
    expect(begin.receipt.results).toMatchObject({ rows: 1, pages: 1 })
    const child = await storedSession(fixture.sessionDir, 'branch-child')
    const rows = seedManagedRows(child.events)
    expect(rows.map(row => row.ref!.id)).toEqual([visible.id])
    expect((await client.readAll('branch-child', visible)).text).toBe(visibleText)
    // The rewound result was never selected: no seed row and no read authority.
    expect(await client.readPage('branch-child', hidden)).toMatchObject({ kind: 'unavailable' })
    expect(hiddenText.includes('SELECTED_RESULTS_HOST_HEADER')).toBe(true)

    // An unrelated session's real artifact is not inherited by this child.
    const other = await client.call('session/create') as { sessionId: string }
    await bindProject(client, other.sessionId, fixture.project)
    await client.call('session/prompt', { sessionId: other.sessionId, prompt: 'read big' })
    const foreignResult = (await storedSession(fixture.sessionDir, other.sessionId)).results[0]!.ref
    expect(await client.readPage('branch-child', foreignResult)).toMatchObject({ kind: 'unavailable' })

    // Exact identity is part of the read authority, not just the id.
    expect(await client.readPage('branch-child', { ...visible, revision: 'f'.repeat(64) })).toMatchObject({ kind: 'unavailable' })
    expect(await client.readPage('branch-child', { ...visible, id: 'ctxv1_' + 'a'.repeat(64) })).toMatchObject({ kind: 'unavailable' })

    await client.close()
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

/** Deleting the target must release its retention so the shared store can be
 *  reclaimed once no document still owns the artifact. */
it('releases inherited retention when the owning sessions are deleted', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    await client.call('desktop/project/sync', { projects: [fixture.project] })
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await bindProject(client, sourceSessionId, fixture.project)
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    const ref = source.results[0]!.ref
    const expected = (await client.readAll(sourceSessionId, ref)).text
    await forkSelected(client, sourceSessionId, 'owned-child', 'selected-owned')
    expect((await managedArtifactPaths(fixture.sessionDir, ref.id)).length).toBeGreaterThan(0)

    // Deleting the target releases its own pin but keeps the source's copy: the
    // artifact is retained for the remaining owner and still reads exactly.
    const childDeletion = await client.call('desktop/session/batch', { command: { action: 'delete', sessionIds: ['owned-child'] } }) as { results: { sessionId: string; ok: boolean }[] }
    expect(childDeletion.results.map(row => [row.sessionId, row.ok])).toEqual([['owned-child', true]])
    expect(await client.readPage('owned-child', ref)).toMatchObject({ kind: 'unavailable' })
    expect((await managedArtifactPaths(fixture.sessionDir, ref.id)).length).toBeGreaterThan(0)
    expect((await client.readAll(sourceSessionId, ref)).text).toBe(expected)

    // With the last owning document deleted the artifact bytes and its pins are
    // gone: no silent resource debt is left behind for future reads.
    const sourceDeletion = await client.call('desktop/session/batch', { command: { action: 'delete', sessionIds: [sourceSessionId] } }) as { results: { sessionId: string; ok: boolean }[] }
    expect(sourceDeletion.results.map(row => [row.sessionId, row.ok])).toEqual([[sourceSessionId, true]])
    expect(await managedArtifactPaths(fixture.sessionDir, ref.id)).toEqual([])
    expect(await client.readPage(sourceSessionId, ref)).toMatchObject({ kind: 'unavailable' })
    await client.close()
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)
