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
it('keeps failed unused replacement reachable for fence retry and final release is exactly once',()=>{
  let releases=0,refuse=true
  const replacement:WaitDrainReservation={unregister(){throw Error('unused')},rejoin(){},release(){releases++;if(refuse)throw null}}
  const initial:WaitDrainReservation={unregister(){throw Error('unused')},rejoin(){},release(){}}
  const credit=createChannelWaitCredit({reserve(){return replacement}},initial)
  const generation=credit.reserve();generation.release()
  let threw=false;try{credit.fence()}catch(error){threw=true;expect(error).toBeNull()};expect(threw).toBe(true)
  expect(()=>credit.reserve()).toThrow();refuse=false;credit.fence();credit.fence();generation.release();expect(releases).toBe(2)
})
it('delegates with exact original receivers and renews synchronously before competing microtask admission',async()=>{
  const events:string[]=[];let available=false,id=0
  const make=():WaitDrainReservation=>{const number=++id;const original:WaitDrainReservation={unregister(){expect(this).toBe(original);throw Error('unused')},rejoin(){expect(this).toBe(original)},release(){expect(this).toBe(original);events.push('release'+number);available=true;if(number===1)queueMicrotask(()=>{try{client.reserve();events.push('stolen')}catch{events.push('competitor-refused')}})}};return original}
  const client={reserve(){expect(this).toBe(client);if(!available)throw Error('full');events.push('reserve');available=false;return make()}}
  const credit=createChannelWaitCredit(client,make()),generation=credit.reserve()
  generation.rejoin();generation.release();expect(events).toEqual(['release1','reserve'])
  await Promise.resolve();expect(events).toEqual(['release1','reserve','competitor-refused'])
  credit.fence();credit.fence();expect(events.at(-1)).toBe('release2')
})
it('cleanup preparation preserves ordinary unused and active credit for original I/O observations',()=>{
  let releases=0,reserves=0
  const make=():WaitDrainReservation=>({unregister(){throw Error('unused')},rejoin(){},release(){releases++}})
  const credit=createChannelWaitCredit({reserve(){reserves++;return make()}},make())
  credit.retireFailedRenewal();expect(releases).toBe(0)
  const first=credit.reserve();credit.retireFailedRenewal();first.release()
  expect(reserves).toBe(1);credit.retireFailedRenewal()
  const replacement=credit.reserve();replacement.release();credit.fence()
  expect(reserves).toBe(2);expect(releases).toBe(3)
})
it('cleanup preparation completes only the acknowledged failed renewal without double release',()=>{
  let releases=0
  const original:WaitDrainReservation={unregister(){throw Error('unused')},rejoin(){},release(){releases++}}
  const credit=createChannelWaitCredit({reserve(){throw false}},original),generation=credit.reserve()
  let failed=false;try{generation.release()}catch(error){failed=true;expect(error).toBe(false)};expect(failed).toBe(true)
  credit.retireFailedRenewal();generation.release();generation.release();credit.fence()
  expect(releases).toBe(1);expect(()=>credit.reserve()).toThrow('unavailable')
})
