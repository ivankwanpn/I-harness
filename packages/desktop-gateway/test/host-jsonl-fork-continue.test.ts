import { expect, it } from 'vitest'
import { createSelectedResultsHostFixture, forkSelected, storedSession } from './helpers/selected-results-host.ts'

// A selected-results (v3) fork child is a first-class continuation on the JSONL
// store too. The target is born through the dedicated selected journal lane, so
// its first turn must re-bind that original lane instead of writing through the
// ordinary journal path, which refuses a v3 birth. The forking process also has
// to release the ready target's birth document so the child can acquire its own
// execution attachment. Both paths must end in a clean host close.
function turnEnds(events: { type: string }[]): number {
  return events.filter(event => event.type === 'turn/end').length
}

it('continues a selected-results fork child in the forking JSONL host', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  let closed = false
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    await client.call('session/prompt', { sessionId: created.sessionId, prompt: 'read big' })
    expect(client.stats).toMatchObject({ modelCalls: 2, toolCalls: 1 })
    const { begin } = await forkSelected(client, created.sessionId, 'child', 'warm-continue')
    expect(begin).toMatchObject({ kind: 'ready', sessionId: 'child', capture: 'captured' })

    // The child's first turn runs for real: the controlled provider is called
    // once and the turn is committed to the child's own durable history.
    expect(await client.call('session/prompt', { sessionId: 'child', prompt: 'child turn' }))
      .toMatchObject({ sessionId: 'child', ok: true })
    expect(client.stats).toMatchObject({ modelCalls: 3, toolCalls: 1 })
    const child = await storedSession(fixture.sessionDir, 'child', 'jsonl')
    expect(turnEnds(child.events)).toBe(1)

    await client.close()
    closed = true
  } finally {
    if (!closed) await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)

it('continues an adopted selected-results fork child after a JSONL host restart', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  let client = await fixture.open()
  let closed = false
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    await client.call('session/prompt', { sessionId: created.sessionId, prompt: 'read big' })
    const { operation } = await forkSelected(client, created.sessionId, 'child', 'restart-continue')
    await client.close()
    closed = true

    client = await fixture.open()
    closed = false
    await client.call('initialize')
    // The restarted host has no in-memory fork entry: the durable birth is
    // adopted through the operation token, exactly like a post-crash retry.
    const retried = await client.call('session/fork/retry', { operation }) as { kind: string; sessionId: string }
    expect(retried).toMatchObject({ kind: 'adopted', sessionId: 'child' })

    expect(await client.call('session/prompt', { sessionId: 'child', prompt: 'adopted child turn' }))
      .toMatchObject({ sessionId: 'child', ok: true })
    expect(client.stats).toMatchObject({ modelCalls: 1, toolCalls: 0 })
    const child = await storedSession(fixture.sessionDir, 'child', 'jsonl')
    expect(turnEnds(child.events)).toBe(1)

    await client.close()
    closed = true
  } finally {
    if (!closed) await client.close().catch(() => {})
    await fixture.dispose()
  }
}, 180000)

it('replays the original fork operation after the child has run turns', async () => {
  const fixture = await createSelectedResultsHostFixture({ store: 'jsonl' })
  const client = await fixture.open()
  try {
    await client.call('initialize')
    const created = await client.call('session/create') as { sessionId: string }
    await client.call('session/prompt', { sessionId: created.sessionId, prompt: 'read big' })
    const { operation } = await forkSelected(client, created.sessionId, 'child', 'replay-continue')
    await expect(client.call('session/prompt', { sessionId: 'child', prompt: 'child turn 1' })).resolves.toMatchObject({ ok: true })
    await expect(client.call('session/prompt', { sessionId: 'child', prompt: 'child turn 2' })).resolves.toMatchObject({ ok: true })
    // Replaying the original operation must adopt the same target without
    // retiring the execution document the completed turns already mounted.
    const adopted = await client.call('session/fork/retry', { operation }) as { kind: string; sessionId: string }
    expect(adopted).toMatchObject({ kind: 'adopted', sessionId: 'child' })
    await expect(client.call('session/prompt', { sessionId: 'child', prompt: 'child turn 3' })).resolves.toMatchObject({ ok: true })
    const child = await storedSession(fixture.sessionDir, 'child', 'jsonl')
    expect(turnEnds(child.events)).toBe(3)
    await client.close()
  } finally { await client.close().catch(() => {}); await fixture.dispose() }
}, 180000)