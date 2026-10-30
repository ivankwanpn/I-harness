import { expect, it } from 'vitest'
import { createChannelWaitCredit } from '../src/channel-wait-credit.ts'
import type { WaitDrainReservation } from '../src/native-wait-bridge.ts'

it('renews the exact credit synchronously and releases the final unused credit', () => {
  const events: string[] = []; let n = 0
  const make = (): WaitDrainReservation => { const id = ++n; return { unregister() { throw Error('unused') }, rejoin() {}, release() { events.push(`release${id}`) } } }
  const client = { reserve() { events.push('reserve'); return make() } }
  const credit = createChannelWaitCredit(client, make())
  const first = credit.reserve(); first.release()
  expect(events).toEqual(['release1', 'reserve'])
  credit.fence(); expect(events).toEqual(['release1', 'reserve', 'release2'])
  expect(() => credit.reserve()).toThrow()
})

it('retains release refusal and distinguishes failed renewal from old debt', () => {
  let releases = 0, fail = true
  const original: WaitDrainReservation = { unregister() { throw Error('unused') }, rejoin() {}, release() { releases++; if (fail) throw Error('refused') } }
  const credit = createChannelWaitCredit({ reserve() { throw Error('renew failed') } }, original)
  const supplied = credit.reserve()
  expect(() => supplied.release()).toThrow('refused'); expect(releases).toBe(1)
  fail = false; expect(() => supplied.release()).toThrow('renew failed'); expect(releases).toBe(2)
  expect(() => supplied.release()).toThrow('renew failed'); expect(releases).toBe(2)
  credit.fence(); expect(releases).toBe(2)
  expect(() => credit.reserve()).toThrow()
})
