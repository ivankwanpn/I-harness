import { inspect } from 'node:util'
import { expect, it } from 'vitest'
import { createDeliveryFixture } from './helpers/required-task-delivery-fixture.ts'
import { isOriginalSpawnChainAcknowledged } from '../../subagent/src/tools/source-run.ts'
import { originalTaskAcknowledgmentRecovery } from '@i-harness/session-persistence/internal/task-persistence'
import { OriginalTerminalRecoveryError } from '../../subagent/src/task-notification.ts'

const expectedWarnings = ["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]

it('discharges only the same original entry, completion chain and recovered ACK occurrence', async () => {
  const f = await createDeliveryFixture({ b2: true, dropTaskACKOnce: true, holdOriginalSourceCloseACK: true, expectedWarnings })
  let other: Awaited<ReturnType<typeof createDeliveryFixture>> | undefined
  let drain: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  try {
    await f.start(); await f.waitForChildStarted()
    const original = f.originalSpawnForTest()
    const rejected = original.chain.then(() => { throw Error('Original ACK failure did not reach the original chain') }, cause => cause)
    f.releaseChild()
    const capturedError = await rejected
    expect(originalTaskAcknowledgmentRecovery(capturedError)).toBeDefined()
    drain = f.settleOriginalSpawnSources(); void drain.catch(() => {})
    await Promise.race([f.waitForOriginalSourceCloseACK(), drain.then(() => { throw Error('Original source closed before its held ACK') })])
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, capturedError)).toBe(false)
    f.releaseOriginalSourceCloseACK(); await drain
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, capturedError)).toBe(true)
    expect(isOriginalSpawnChainAcknowledged({ ...original.entry }, original.chain, capturedError)).toBe(false)
    const replacement = Promise.reject(capturedError); void replacement.catch(() => {})
    const previous = original.entry.followupChain
    try {
      original.entry.followupChain = replacement
      expect(isOriginalSpawnChainAcknowledged(original.entry, original.entry.followupChain, capturedError)).toBe(false)
    } finally { original.entry.followupChain = previous }
    const lookalike = new Error(capturedError instanceof Error ? capturedError.message : 'copied recovery')
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, lookalike)).toBe(false)

    other = await createDeliveryFixture({ b2: true, expectedWarnings })
    await other.start(); await other.waitForChildStarted()
    const foreign = other.originalSpawnForTest()
    other.releaseChild(); await foreign.chain; await other.settleOriginalSpawnSources()
    expect(isOriginalSpawnChainAcknowledged(foreign.entry, foreign.chain, capturedError)).toBe(false)
    expect(f.launchCount()).toBe(1); expect(other.launchCount()).toBe(1)
    expect((await f.backend.read('parent')).events.filter(event => event.type === 'subagent/end')).toHaveLength(1)
  } catch (cause) { primary = { cause } }
  finally {
    f.releaseChild(); f.releaseOriginalSourceCloseACK(); other?.releaseChild()
    const failures: unknown[] = []
    if (drain) await drain.catch(cause => { if (!primary || cause !== primary.cause) failures.push(cause) })
    for (const cleanup of [() => other?.close(), () => f.close()]) try { await cleanup() } catch (cause) { failures.push(cause) }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original ACK identity and cleanup must both hold')
  }
}, 60000)

it('joins a held original source ACK in the first external close without hiding the chain failure on a second attempt', async () => {
  const closeWarnings = [
    '[i-harness] original delivery settlement: FactRecoveryRequiredError: Managed facts require reconciliation',
    '[i-harness] delivery reconciliation failed: FactRecoveryRequiredError: Managed facts require reconciliation',
  ]
  const f = await createDeliveryFixture({ b2: true, dropTaskACKOnce: true, holdOriginalSourceCloseACK: true, expectedWarnings: [...expectedWarnings,...closeWarnings] })
  let drain: Promise<void> | undefined, closing: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  try {
    await f.start(); await f.waitForChildStarted()
    const original = f.originalSpawnForTest()
    const rejected = original.chain.then(() => { throw Error('Original ACK failure did not reach the original chain') }, cause => cause)
    f.releaseChild(); const capturedError = await rejected
    expect(originalTaskAcknowledgmentRecovery(capturedError)).toBeDefined()
    drain = f.settleOriginalSpawnSources(); void drain.catch(() => {})
    await Promise.race([f.waitForOriginalSourceCloseACK(), drain.then(() => { throw Error('Original source closed before its held ACK') })])
    let closed = false
    closing = f.service.close(); void closing.then(() => { closed = true }, () => {})
    // Close admission retires immediately, before accepted notification/source
    // joins. Waiting for child disposal here would wait on the ACK we hold.
    await expect(f.service.contextState('parent')).rejects.toThrow('session service closed')
    expect(closed).toBe(false)
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, capturedError)).toBe(false)
    f.releaseOriginalSourceCloseACK()
    await drain
    await closing // This first promise must succeed; finally cannot repair its assertion.
    expect(closed).toBe(true)
    expect(f.launchCount()).toBe(1)
    expect((await f.backend.read('parent')).events.filter(event => event.type === 'subagent/end')).toHaveLength(1)
  } catch (cause) { primary = { cause } }
  finally {
    f.releaseChild(); f.releaseOriginalSourceCloseACK()
    const failures: unknown[] = []
    for (const flight of [drain, closing]) if (flight) await flight.catch(cause => { if (!primary || cause !== primary.cause) failures.push(cause) })
    try {
      await f.close()
      expect(f.warningMessages().filter(message => closeWarnings.includes(message))).toEqual(closeWarnings)
    } catch (cause) { failures.push(cause) }
    if (primary || failures.length) {
      console.info('original-held-ACK-primary', inspect({primary,failures},{depth:18}))
      throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'The first original close and cleanup must both acknowledge')
    }
  }
}, 60000)

it('requires the constructor-issued terminal UNKNOWN recovery occurrence to retire on its same original source', async () => {
  const f = await createDeliveryFixture({ b2: true, holdTerminalUnknown: true, holdOriginalSourceCloseACK: true, expectedWarnings })
  let drain: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  try {
    await f.start(); await f.waitForChildStarted()
    const original = f.originalSpawnForTest()
    const rejected = original.chain.then(() => { throw Error('Original terminal failure did not reach the original chain') }, cause => cause)
    f.releaseChild(); await f.waitForHeldTerminal()
    const capturedError = await rejected
    expect(capturedError).toBeInstanceOf(OriginalTerminalRecoveryError)
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, capturedError)).toBe(false)
    f.releaseTerminalOutcome()
    drain = f.settleOriginalSpawnSources(); void drain.catch(() => {})
    await Promise.race([f.waitForOriginalSourceCloseACK(), drain.then(() => { throw Error('Original source closed before its held ACK') })])
    f.releaseOriginalSourceCloseACK(); await drain
    expect(isOriginalSpawnChainAcknowledged(original.entry, original.chain, capturedError)).toBe(true)
    expect(f.launchCount()).toBe(1)
    expect((await f.backend.read('parent')).events.filter(event => event.type === 'subagent/end')).toHaveLength(1)
  } catch (cause) { primary = { cause } }
  finally {
    f.releaseTerminalOutcome(); f.releaseOriginalSourceCloseACK(); f.releaseChild()
    const failures: unknown[] = []
    if (drain) await drain.catch(cause => { if (!primary || cause !== primary.cause) failures.push(cause) })
    try { await f.close() } catch (cause) { failures.push(cause) }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original terminal UNKNOWN and cleanup must both acknowledge')
  }
}, 60000)
