import { CURRENT_FORMAT_VERSION, freezeJsonData, type SessionView } from '@i-harness/core-session'
import { expect, it } from 'vitest'
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts'
import { createColdProcessReadOwner } from '../src/coordinator/process-read-owner.ts'
import type { ProcessReadStorage } from '../src/coordinator/process-read-storage.ts'

function coldOwner(reusable: boolean) {
  const initial: SessionView = freezeJsonData({ formatVersion: CURRENT_FORMAT_VERSION, events: [] })
  let captures = 0, finishes = 0
  const storage: ProcessReadStorage = {
    async capture() {
      const version = ++captures
      return {
        initial, ...(reusable ? { reusableInitial: true as const } : {}),
        documents: new Map([['s', { kind: 'present' as const, value: version }]]),
        async check() {},
        async finish() { finishes++ },
      }
    },
    async captureManagedAuxiliary() { throw Error('Unexpected managed read') },
  }
  return { owner: createColdProcessReadOwner(storage, createProcessReadLatches()), finishes: () => finishes }
}

it.each([true, false])('reuses only a qualified immutable cold transcript and checks fresh documents (qualified=%s)', async reusable => {
  const { owner, finishes } = coldOwner(reusable)
  const read = () => owner.run('s', { documentKeys: ['s'] }, async observation => observation.initial,
    async (candidate, observation) => { observation.assertCurrent(); return candidate })
  const first = await read(), second = await read()
  expect(second.session === first.session).toBe(reusable)
  expect(first.documents.get('s')).toEqual({ kind: 'present', value: 1 })
  expect(second.documents.get('s')).toEqual({ kind: 'present', value: 2 })
  expect(finishes()).toBe(2)
})

it('admits prepared cold data only after publication succeeds', async () => {
  const { owner, finishes } = coldOwner(true)
  let rejected: SessionView | undefined
  await expect(owner.run('s', { documentKeys: [] }, async observation => {
    rejected = observation.initial.session
  }, async () => { throw Error('Publication failed') })).rejects.toThrow('Publication failed')
  const read = () => owner.run('s', { documentKeys: [] }, async observation => observation.initial.session, async candidate => candidate)
  const published = await read()
  expect(rejected).toBeDefined()
  expect(published).not.toBe(rejected)
  expect(await read()).toBe(published)
  expect(finishes()).toBe(3)
})
