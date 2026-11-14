import { expect, it, vi } from 'vitest'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import * as preparation from '../../session-persistence/src/coordinator/selected-results-preparation.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'

it('reuses immutable selected preparation facts while retaining live owner checks', async () => {
  const fixture = await createGatewayForkFixture()
  const derive = vi.spyOn(preparation, 'selectedResultsPreparationFacts')
  let holder: ReturnType<typeof fixture.runtime.createSelectedSourceHolder> | undefined
  try {
    await fixture.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'original' }, { type: 'turn/end' }])
    const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
    const { intent, requestDigest } = createSelectedResultsIntent(core, { kind: 'project', projectId: 'p' })
    const operation = readSelectedResultsOperation({ version: 2, kind: 'session-fork-operation', prepared: { version: 2, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest }, invocation: { version: 1, operationId: 'immutable-facts', targetSessionId: 'target', createdAt: '2026-10-28T00:00:00.000Z', requestDigest } })
    holder = fixture.runtime.createSelectedSourceHolder(operation)
    expect((await holder.captureFirst()).kind).toBe('captured')
    expect((await holder.confirmTarget()).kind).toBe('confirmed')
    const derived = derive.mock.calls.length
    expect(derived).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 3; attempt++) expect((await holder.confirmTarget()).kind).toBe('confirmed')
    expect(derive).toHaveBeenCalledTimes(derived)
    const facts = derive.mock.results.at(-1)!.value as ReturnType<typeof preparation.selectedResultsPreparationFacts>
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Reflect.set(facts.semantic.results, 'rows', 999)).toBe(false)
    expect(Reflect.set(facts.semantic.turns.completed[0]!, '0', 999)).toBe(false)
    await (await fixture.coordinator.openManagedDocument('source')).metadata.enterPlan('changed')
    await expect(holder.confirmTarget()).rejects.toThrow()
    expect(derive).toHaveBeenCalledTimes(derived)
  } finally {
    derive.mockRestore()
    await holder?.close()
    await fixture.close()
  }
}, 60000)
