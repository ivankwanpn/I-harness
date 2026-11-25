import { expect, it, vi } from 'vitest'
import * as executor from '@i-harness/session-executor'
import { createSelectedResultsHostFixture, executeSelected, prepareSelected, storedSession } from './helpers/selected-results-host.ts'

const review = vi.hoisted(() => ({ previous: false, failGrant: false, grantFailures: 0 }))

vi.mock('../src/selected-fork.ts', async importOriginal => {
  const current = await importOriginal<typeof import('../src/selected-fork.ts')>()
  const previous = await import('./helpers/legacy-selected-fork-controller.ts')
  return {
    ...current,
    createSelectedForkController(options: Parameters<typeof current.createSelectedForkController>[0]) {
      return (review.previous ? previous : current).createSelectedForkController(options)
    },
  }
})

vi.mock('../src/context-runtime.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/context-runtime.ts')>()
  return {
    ...actual,
    async createNativeContextRuntime(...args: Parameters<typeof actual.createNativeContextRuntime>) {
      const runtime = await actual.createNativeContextRuntime(...args)
      const output = runtime.contextOutput
      const grant = output.grant.bind(output)
      const wrapped = new Proxy(output, {
        get(target, property) {
          if (property === 'grant') return async (...grantArgs: Parameters<typeof grant>) => {
            if (review.failGrant) {
              review.failGrant = false
              review.grantFailures += 1
              throw new Error('injected single retention write failure')
            }
            return grant(...grantArgs)
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return new Proxy(runtime, {
        get(target, property) {
          if (property === 'contextOutput') return wrapped
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

type Host = Awaited<ReturnType<Awaited<ReturnType<typeof createSelectedResultsHostFixture>>['open']>>

async function active(client: Host, id: string): Promise<boolean> {
  const listing = await client.call('session/list') as { sessions: { id: string }[] }
  return listing.sessions.some(row => row.id === id)
}

async function prepare(client: Host, fixture: Awaited<ReturnType<typeof createSelectedResultsHostFixture>>, id: string) {
  await client.call('initialize')
  const { sessionId } = await client.call('session/create') as { sessionId: string }
  await client.call('session/prompt', { sessionId, prompt: 'read big' })
  expect((await storedSession(fixture.sessionDir, sessionId)).results).toHaveLength(1)
  return (await prepareSelected(client, sessionId, id, 'review-fork-archive')).operation
}

it('keeps a failed pending fork out of the archive and ordinary restore', async () => {
  const fixture = await createSelectedResultsHostFixture()
  let sessionService: executor.SessionService | undefined
  const makeService = executor.createSessionService
  const serviceFactory = vi.spyOn(executor, 'createSessionService').mockImplementation(options => sessionService = makeService(options))
  let client: Host | undefined
  const id = 'review-pending-target'
  try {
    client = await fixture.open()
    if (!sessionService) throw new Error('Missing original desktop session service')
    serviceFactory.mockRestore()
    const operation = await prepare(client, fixture, id)
    review.grantFailures = 0
    review.failGrant = true
    await expect(executeSelected(client, operation)).rejects.toThrow('Session fork unavailable')
    expect(review.grantFailures).toBe(1)
    expect(await active(client, id)).toBe(false)
    const archived = await client.call('desktop/session/archived') as { id: string }[]
    const listedAsArchived = archived.some(row => row.id === id)
    const restored = await client.call('desktop/session/manage', { sessionId: id, action: 'restore' }).then(() => true, () => false)
    const visibleAfterRestore = await active(client, id)
    const header = (await storedSession(fixture.sessionDir, id)).header
    console.info(JSON.stringify({ case: 'pending visibility', listedAsArchived, restored, visibleAfterRestore, header, grantFailures: review.grantFailures }))
    expect({ listedAsArchived, restored, visibleAfterRestore }).toEqual({ listedAsArchived: false, restored: false, visibleAfterRestore: false })
    const before = await storedSession(fixture.sessionDir, id)
    const modelCalls = client.stats.modelCalls
    const attach = vi.spyOn(sessionService, 'managedInputFor')
    try {
      await expect(client.call('desktop/session/input/submit', {
        sessionId: id, text: 'fixture input', delivery: 'queue', clientToken: 'pending-checked-input',
      })).rejects.toThrow('Session is unavailable')
      expect(attach).not.toHaveBeenCalled()
      expect(client.stats.modelCalls).toBe(modelCalls)
      expect(await storedSession(fixture.sessionDir, id)).toEqual(before)
    } finally { attach.mockRestore() }
    // The same original operation can still finish and publish the target.
    const retried = await executeSelected(client, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'ready', sessionId: id })
    expect(await active(client, id)).toBe(true)
    const published = (await storedSession(fixture.sessionDir, id)).header
    expect(published).toMatchObject({ archived: false, forkPublication: 'published' })
  } finally {
    review.failGrant = false
    serviceFactory.mockRestore()
    try { await client?.close() } finally { await fixture.dispose() }
  }
}, 120000)

it('preserves the archive of a completed fork written by the preceding controller', async () => {
  const fixture = await createSelectedResultsHostFixture()
  const id = 'review-previous-target'
  let client: Host | undefined
  try {
    review.previous = true
    client = await fixture.open()
    const operation = await prepare(client, fixture, id)
    const ready = await executeSelected(client, operation)
    expect(ready.kind).toBe('ready')
    await client.call('desktop/session/manage', { sessionId: id, action: 'archive' })
    expect(await active(client, id)).toBe(false)
    const before = (await storedSession(fixture.sessionDir, id)).header
    expect(before).toMatchObject({ archived: true })
    expect(before).not.toHaveProperty('forkPublication')
    await client.close()
    client = undefined

    review.previous = false
    client = await fixture.open()
    await client.call('initialize')
    const retried = await executeSelected(client, operation, 'retry')
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: id })
    expect((retried as { receipt?: unknown }).receipt).toBeTruthy()
    const visibleAfterReplay = await active(client, id)
    const after = (await storedSession(fixture.sessionDir, id)).header
    console.info(JSON.stringify({ case: 'old archived fork', outcome: retried.kind, visibleAfterReplay, before, after }))
    expect(visibleAfterReplay).toBe(false)
    expect(after).toMatchObject({ archived: true })
    expect(after.semanticSeed).toEqual(before.semanticSeed)
  } finally {
    review.previous = false
    try { await client?.close() } finally { await fixture.dispose() }
  }
}, 120000)
