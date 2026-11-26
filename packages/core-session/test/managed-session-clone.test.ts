import { expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION, type Session } from '../src/events/types.ts'
import { freezeJsonData } from '../src/managed/capture.ts'
import { createManagedSessionStateFromClone, prepareManagedSessionClone, type ManagedSessionClone } from '../src/restoration-internal.ts'

function nativeClone(): Session {
  const source: Session = {
    formatVersion: CURRENT_FORMAT_VERSION,
    header: { origin: 'cli' },
    events: [{ type: 'tool/call', callId: 'call', name: 'read', seq: 0,
      args: { '10': '十', '2': '二', z: '雪', a: ['工作區', { note: '\ud800' }] } }],
  }
  return freezeJsonData(JSON.parse(JSON.stringify(source))) as Session
}

it('adopts the exact frozen initial rows once and keeps the live appendable array private', () => {
  const source = nativeClone(), prefix = source.events[0]!
  const clone = prepareManagedSessionClone(source, 'document')
  expect(clone).toBeDefined()
  expect(prepareManagedSessionClone(source, 'document')).toBeUndefined()
  const adopted = createManagedSessionStateFromClone(source, 'document', clone)
  expect(adopted.view.events[0]).toBe(prefix)
  expect(adopted.view.events).not.toBe(source.events)
  expect(adopted.view.header).toEqual(source.header)
  expect(Object.isFrozen(adopted.view.header)).toBe(true)
  if (prefix.type !== 'tool/call') throw new TypeError('Expected original signed arguments')
  expect(Object.keys(prefix.args as object)).toEqual(['2', '10', 'z', 'a'])
  adopted.stage([{ type: 'tool/result', callId: 'call', name: 'read', seq: 1, output: 'file result' }]).install()
  expect(adopted.view.events).toHaveLength(2)
  expect(source.events).toHaveLength(1)
  expect(createManagedSessionStateFromClone(source, 'document', clone).view.events[0]).not.toBe(prefix)
})

it('requires the exact source, capability and owner instead of accepting copies of them', () => {
  const source = nativeClone(), other = nativeClone(), clone = prepareManagedSessionClone(source, 'document')
  expect(clone).toBeDefined()
  const counterfeit = { ...clone } as ManagedSessionClone
  expect(createManagedSessionStateFromClone(source, 'document', counterfeit).view.events[0]).not.toBe(source.events[0])
  expect(createManagedSessionStateFromClone(other, 'document', clone).view.events[0]).not.toBe(other.events[0])
  expect(createManagedSessionStateFromClone(source, 'document', clone).view.events[0]).toBe(source.events[0])

  const scoped = nativeClone(), scopedClone = prepareManagedSessionClone(scoped, 'document')
  expect(scopedClone).toBeDefined()
  expect(createManagedSessionStateFromClone(scoped, 'foreign', scopedClone).view.events[0]).not.toBe(scoped.events[0])
  expect(createManagedSessionStateFromClone(scoped, 'document', scopedClone).view.events[0]).not.toBe(scoped.events[0])
})

it('uses the original capture and expires the capability if the serializer changed', () => {
  const source = nativeClone(), clone = prepareManagedSessionClone(source, 'document')
  expect(clone).toBeDefined()
  const parse = JSON.parse
  try {
    JSON.parse = new Proxy<typeof parse>(parse, { apply: Reflect.apply })
    const captured = createManagedSessionStateFromClone(source, 'document', clone).view.events[0]
    expect(captured).toEqual(source.events[0])
    expect(captured).not.toBe(source.events[0])
  } finally { JSON.parse = parse }
  expect(createManagedSessionStateFromClone(source, 'document', clone).view.events[0]).not.toBe(source.events[0])
})

it('declines shallow freeze or any data that would change under the original JSON capture', () => {
  const shared = { value: 'shared' }
  const differentJson: unknown[] = [
    { omitted: undefined }, { number: -0 }, { left: shared, right: shared }, [1, , 3],
    Object.assign([1], { extra: true }), Object.assign(Object.create(null), { plain: true }),
    Object.defineProperty({}, 'hidden', { value: 'hidden' }),
  ]
  for (const args of differentJson) {
    const source = freezeJsonData({ formatVersion: CURRENT_FORMAT_VERSION,
      events: [{ type: 'tool/call', callId: 'call', name: 'read', seq: 0, args }] }) as Session
    expect(prepareManagedSessionClone(source, 'document')).toBeUndefined()
  }
  const shallow: Session = Object.freeze({ formatVersion: CURRENT_FORMAT_VERSION,
    events: [{ type: 'user/message' as const, seq: 0, text: 'borrowed mutable row' }] })
  expect(prepareManagedSessionClone(shallow, 'document')).toBeUndefined()
})
