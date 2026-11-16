import { expect, it } from 'vitest'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'

function operation(targetSessionId: string, operationId: string) {
  const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source',
    selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
  const { intent, requestDigest } = createSelectedResultsIntent(core, { kind: 'project', projectId: 'p' })
  return readSelectedResultsOperation({ version: 2, kind: 'session-fork-operation',
    prepared: { version: 2, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest },
    invocation: { version: 1, operationId, targetSessionId, createdAt: '2026-10-28T00:00:00.000Z', requestDigest } })
}

/** A closed holder releases its operation identity: the same operation can
 *  rebuild a holder from scratch, while a concurrent duplicate is still refused
 *  before either can capture the source twice. */
it('rebuilds the same operation after its holder closed and refuses a concurrent duplicate', async () => {
  const f = await createGatewayForkFixture()
  try {
    await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'selected' }, { type: 'turn/end' }])
    const selectedOperation = operation('target', 'holder-retry')

    const first = f.runtime.createSelectedSourceHolder(selectedOperation)
    // Ownership is held while the first holder lives.
    expect(() => f.runtime.createSelectedSourceHolder(selectedOperation)).toThrow('Selected operation already owned')
    await first.close()

    // The same operation may now rebuild the original holder and publish.
    const rebuilt = f.runtime.createSelectedSourceHolder(selectedOperation)
    expect(() => f.runtime.createSelectedSourceHolder(selectedOperation)).toThrow('Selected operation already owned')
    const captured = await rebuilt.captureFirst()
    expect(captured.kind).toBe('captured')
    const published = await rebuilt.publishWarm()
    expect(published.kind).toBe('ready')
    await rebuilt.close()
    const document = await f.coordinator.openManagedDocument('target')
    document.assertReady()

    // Once the target has issued its durable header, the kernel target owner
    // refuses a second warm capture for the same operation in this process
    // (recovery after a restart uses the cold qualification instead).
    const stale = f.runtime.createSelectedSourceHolder(selectedOperation)
    await expect(stale.captureFirst()).rejects.toThrow()
    await stale.close()

    // A different operation against the same source is independent.
    const other = f.runtime.createSelectedSourceHolder(operation('target-2', 'holder-retry-other'))
    expect((await other.captureFirst()).kind).toBe('captured')
    await other.close()
  } finally { await f.close() }
}, 60000)

/** Closing is idempotent and each close returns the identity, so a source
 *  acquisition that never issued a header can be retried any number of times
 *  without a leaked "already owned" refusal. */
it('returns the operation identity on every close of an unissued holder', async () => {
  const f = await createGatewayForkFixture()
  try {
    await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'selected' }, { type: 'turn/end' }])
    const selectedOperation = operation('target', 'holder-loop')
    for (let attempt = 0; attempt < 3; attempt++) {
      const holder = f.runtime.createSelectedSourceHolder(selectedOperation)
      expect(() => f.runtime.createSelectedSourceHolder(selectedOperation)).toThrow('Selected operation already owned')
      await holder.close()
      await holder.close()
    }
    const final = f.runtime.createSelectedSourceHolder(selectedOperation)
    expect((await final.captureFirst()).kind).toBe('captured')
    await final.close()
  } finally { await f.close() }
}, 60000)
