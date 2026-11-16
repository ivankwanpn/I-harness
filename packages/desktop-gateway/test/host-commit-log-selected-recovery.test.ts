import { expect, it, vi } from 'vitest'
import {
  bindProject, createSelectedResultsHostFixture, executeSelected, prepareSelected, seedManagedRows, storedSession,
} from './helpers/selected-results-host.ts'

/** Control surface for the real context-output service: count grants and
 *  inject the failure/absence the recovery contract must survive. */
const control = vi.hoisted(() => ({
  failGrants: 0,
  holdGrant: undefined as undefined | (() => Promise<void>),
  grants: [] as { sessionId: string; ids: string[]; targetSessionId: string }[],
}))
vi.mock('../src/context-runtime.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/context-runtime.ts')>()
  const wrapOutput = (service: { grant(access: { sessionId: string }, ids: string[], targetSessionId: string): Promise<void> }) => new Proxy(service, {
    get(target, property) {
      if (property === 'grant') {
        return async (access: { sessionId: string }, ids: string[], targetSessionId: string) => {
          control.grants.push({ sessionId: access.sessionId, ids: [...ids], targetSessionId })
          if (control.holdGrant) await control.holdGrant()
          if (control.failGrants > 0) { control.failGrants--; throw new Error('injected retention grant failure') }
          return target.grant(access, ids, targetSessionId)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    ...actual,
    async createNativeContextRuntime(options: Parameters<typeof actual.createNativeContextRuntime>[0]) {
      const runtime = await actual.createNativeContextRuntime(options)
      return new Proxy(runtime, {
        get(target, property) {
          if (property === 'contextOutput') return wrapOutput(target.contextOutput as never)
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

it('does not acknowledge a failed retention grant and resumes the same operation', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(source.results).toHaveLength(1)
    const ref = source.results[0]!.ref
    const expected = (await client.readAll(sourceSessionId, ref)).text

    control.grants = []
    control.failGrants = 1
    const { operation } = await prepareSelected(client, sourceSessionId, 'grant-failure-child', 'grant-failure')
    // The unacknowledged operation must not report ready while its retention
    // grant is missing.
    await expect(executeSelected(client, operation)).rejects.toThrow()
    expect(control.grants).toHaveLength(1)
    expect(control.grants[0]!.targetSessionId).toBe('grant-failure-child')
    expect(control.grants[0]!.ids).toEqual([ref.id])

    // The same operation resumes on the durable capture: the target birth is
    // idempotent and the missing grant is published before the retry is
    // acknowledged.
    control.failGrants = 0
    const retried = await executeSelected(client, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'ready', sessionId: 'grant-failure-child', capture: 'captured' })
    expect(control.grants).toHaveLength(2)
    expect(control.grants[1]).toEqual(control.grants[0])
    expect((await client.readAll('grant-failure-child', ref)).text).toBe(expected)

    // The durable target is reachable from the ordinary session routes.
    const listed = await client.call('session/list') as { sessions?: { sessionId?: string }[] } | { sessionId?: string }[]
    expect(JSON.stringify(listed)).toContain('grant-failure-child')
    const child = await storedSession(fixture.sessionDir, 'grant-failure-child')
    expect(seedManagedRows(child.events).map(row => row.ref!.id)).toEqual([ref.id])
  } finally {
    control.failGrants = 0
    control.holdGrant = undefined
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

it('adopts the exact receipt on a retried acknowledgement without repeating retention', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    const ref = source.results[0]!.ref

    control.grants = []
    const { operation, begin } = await prepareSelected(client, sourceSessionId, 'ack-child', 'ack-loss').then(async prepared => ({ ...prepared, begin: await executeSelected(client, prepared.operation) }))
    expect(begin).toMatchObject({ kind: 'ready', sessionId: 'ack-child' })
    expect(control.grants).toHaveLength(1)

    const retried = await executeSelected(client, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'ack-child' })
    expect(retried.receipt).toEqual(begin.receipt)
    // No second capture or retention effect on an already acknowledged op.
    expect(control.grants).toHaveLength(1)
    expect(seedManagedRows((await storedSession(fixture.sessionDir, 'ack-child')).events).map(row => row.ref!.id)).toEqual([ref.id])
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

it('keeps the first capture when the source changes before the retry', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const first = await storedSession(fixture.sessionDir, sourceSessionId)
    const firstRef = first.results[0]!.ref

    const { operation, begin } = await prepareSelected(client, sourceSessionId, 'stable-child', 'stable-op').then(async prepared => ({ ...prepared, begin: await executeSelected(client, prepared.operation) }))
    expect(begin).toMatchObject({ kind: 'ready' })

    // The source continues after the fork: a new turn and a new result.
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big again' })
    const advanced = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(advanced.results.length).toBeGreaterThan(1)
    const laterRef = advanced.results.at(-1)!.ref

    const retried = await executeSelected(client, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'stable-child' })
    expect(retried.receipt).toEqual(begin.receipt)
    const rows = seedManagedRows((await storedSession(fixture.sessionDir, 'stable-child')).events)
    expect(rows.map(row => row.ref!.id)).toEqual([firstRef.id])
    expect(await client.readPage('stable-child', laterRef)).toMatchObject({ kind: 'unavailable' })
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

it('adopts a completed operation after a host restart and source archive/clear', async () => {
  const fixture = await createSelectedResultsHostFixture()
  let sourceSessionId = ''
  let ref: { id: string; revision: string; contentDigest: string; encodedBytes: number } = { id: '', revision: '', contentDigest: '', encodedBytes: 0 }
  let expected = ''
  let operation: unknown
  let receipt: unknown
  const first = await fixture.open()
  try {
    await first.call('initialize')
    const created = await first.call('session/create') as { sessionId: string }
    sourceSessionId = created.sessionId
    await bindProject(first, sourceSessionId, fixture.project)
    await first.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    ref = source.results[0]!.ref
    expected = (await first.readAll(sourceSessionId, ref)).text
    const prepared = await prepareSelected(first, sourceSessionId, 'restart-child', 'restart-op')
    operation = prepared.operation
    const begin = await executeSelected(first, operation)
    expect(begin).toMatchObject({ kind: 'ready' })
    receipt = begin.receipt
  } finally { await first.close().catch(() => {}) }

  const second = await fixture.open()
  try {
    await second.call('initialize')
    await second.call('desktop/project/sync', { projects: [fixture.project] })
    await second.call('desktop/session/manage', { sessionId: sourceSessionId, action: 'archive' })
    await second.call('desktop/context-subsystems/action', { command: { target: 'context', action: 'clear', sessionId: sourceSessionId } })
    const retried = await executeSelected(second, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'restart-child' })
    expect(retried.receipt).toEqual(receipt)
    expect((await second.readAll('restart-child', ref)).text).toBe(expected)
  } finally {
    await second.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)

it('honours a completed selection boundary before the fork', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const first = await storedSession(fixture.sessionDir, sourceSessionId)
    const firstRef = first.results[0]!.ref
    const firstResultSeq = first.results[0]!.seq
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big again' })
    const advanced = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(advanced.results).toHaveLength(2)
    const laterRef = advanced.results[1]!.ref

    // A boundary inside the first turn selects that completed turn only.
    const { operation } = await prepareSelected(client, sourceSessionId, 'boundary-child', 'boundary-op', { kind: 'completed', atSeq: firstResultSeq })
    const begin = await executeSelected(client, operation)
    expect(begin).toMatchObject({ kind: 'ready', sessionId: 'boundary-child' })
    expect(begin.receipt.results).toMatchObject({ rows: 1, pages: 1 })
    const rows = seedManagedRows((await storedSession(fixture.sessionDir, 'boundary-child')).events)
    expect(rows.map(row => row.ref!.id)).toEqual([firstRef.id])
    expect(await client.readPage('boundary-child', laterRef)).toMatchObject({ kind: 'unavailable' })
  } finally {
    await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 120000)

it('resumes an unfinished operation from its durable capture after a restart and source change', async () => {
  const fixture = await createSelectedResultsHostFixture()
  let operation: unknown
  let sourceSessionId = ''
  let eventsBeforeRetry = 0
  let firstRef: { id: string; revision: string; contentDigest: string; encodedBytes: number } = { id: '', revision: '', contentDigest: '', encodedBytes: 0 }
  let expected = ''
  const first = await fixture.open()
  try {
    await first.call('initialize')
    const created = await first.call('session/create') as { sessionId: string }
    sourceSessionId = created.sessionId
    await first.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const source = await storedSession(fixture.sessionDir, sourceSessionId)
    eventsBeforeRetry = source.events.length
    firstRef = source.results[0]!.ref
    expected = (await first.readAll(sourceSessionId, firstRef)).text
    control.grants = []
    control.failGrants = 1
    const prepared = await prepareSelected(first, sourceSessionId, 'unfinished-child', 'unfinished-op')
    operation = prepared.operation
    await expect(executeSelected(first, operation)).rejects.toThrow()
    expect(control.grants).toHaveLength(1)
  } finally { await first.close().catch(() => {}) }

  const second = await fixture.open()
  try {
    await second.call('initialize')
    // The source moves on after the unacknowledged attempt.
    await second.call('session/prompt', { sessionId: sourceSessionId, prompt: 'continue after restart' })
    const advanced = await storedSession(fixture.sessionDir, sourceSessionId)
    expect(advanced.events.length).toBeGreaterThan(eventsBeforeRetry)
    control.failGrants = 0
    const retried = await executeSelected(second, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'ready', sessionId: 'unfinished-child' })
    const rows = seedManagedRows((await storedSession(fixture.sessionDir, 'unfinished-child')).events)
    expect(rows.map(row => row.ref!.id)).toEqual([firstRef.id])
    expect((await second.readAll('unfinished-child', firstRef)).text).toBe(expected)
  } finally {
    control.failGrants = 0
    await second.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)
it('refuses a project binding that changed between prepare and begin', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    const sourceSessionId = created.sessionId
    await bindProject(client, sourceSessionId, fixture.project)
    await client.call('session/prompt', { sessionId: sourceSessionId, prompt: 'read big' })
    const { operation } = await prepareSelected(client, sourceSessionId, 'policy-child', 'policy-op')
    // The source is moved to a different project before the begin.
    const other = { ...fixture.project, id: 'project-2', name: 'Second project' }
    await client.call('desktop/project/sync', { projects: [fixture.project, other] })
    const moved = await client.call('desktop/session/batch', { command: { action: 'move', sessionIds: [sourceSessionId], expectedOwners: { [sourceSessionId]: fixture.project.id }, projectId: other.id } }) as { results: { ok: boolean }[] }
    expect(moved.results[0]).toMatchObject({ ok: true })
    const refused = await executeSelected(client, operation)
    expect(refused).toMatchObject({ kind: 'not-issued', reason: 'policy' })
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
}, 120000)