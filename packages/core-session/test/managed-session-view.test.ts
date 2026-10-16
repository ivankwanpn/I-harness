import { expect, it } from 'vitest'
import * as core from '../src/index.ts'

it('owns hydration aliases and rejects reflective, callback and iterator mutation', () => {
  const source = { formatVersion: 6, header: { origin: 'root' }, events: [{ type: 'tool/call' as const, seq: 0, callId: 'a', name: 'read', args: { z: { value: 1 } } }] }
  const state = core.createManagedSessionState(source)
  const view = state.view
  source.events[0]!.args.z.value = 99
  expect(view.events[0]).toEqual({ type: 'tool/call', seq: 0, callId: 'a', name: 'read', args: { z: { value: 1 } } })
  expect(() => Reflect.set(view.events, '0', { type: 'turn/start' })).toThrow()
  expect(() => Object.setPrototypeOf(view.events, null)).toThrow()
  view.events.forEach((_event, _index, receiver) => {
    expect(receiver).toBe(view.events)
    expect(() => Reflect.set(receiver, 'length', 0)).toThrow()
  })
  const descriptor = Object.getOwnPropertyDescriptor(view.events, '0')!.value
  expect(() => { descriptor.args.z.value = 88 }).toThrow()
  expect(() => { (view.events.entries().next().value![1] as any).args.z.value = 77 }).toThrow()
  expect(() => { (view.header as any).origin = 'changed' }).toThrow()
  expect(() => core.append(view as any, { type: 'turn/start' })).toThrow(/managed/i)
})

it('captures legacy JSON behavior once and keeps failed capture explicit', () => {
  let reads = 0
  const captured = core.captureLegacyFact({ type: 'tool/result', callId: 'a', name: 'read', output: { toJSON() { reads++; return { z: 1, a: 2 } } } })
  expect(captured.kind).toBe('captured')
  expect(reads).toBe(1)
  const cycle: any = {}; cycle.self = cycle
  expect(core.captureLegacyFact(cycle)).toEqual({ kind: 'not-issued', code: 'FACT_CAPTURE_FAILED' })
})

it('rejects strict native and context DTO accessors without invoking their code', () => {
  let reads = 0
  const continuation = { kind: 'gemini', model: 'm', get opaque() { reads++; return 'private' } }
  expect(core.captureFactGroup({ kind: 'exchange-acceptance', assistant: { type: 'assistant/message', text: '', providerContinuation: continuation }, accepted: {} } as any)).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(reads).toBe(0)
})

it('resolves only the typed usage acceptedSeq slot against the committed accepted event', () => {
  const events = Array.from({ length: 7 }, (_, seq) => ({ type: 'plan/mode', mode: 'on', seq }))
  const view = { formatVersion: 6, events: [...events, { type: 'model/exchange-accepted', version: 2, seq: 7 }] } as any
  const captured = core.captureFactGroup({ kind: 'usage', event: { type: 'context/usage', version: 2, op: 'sample', checkpoint: { accepted: { acceptedSeq: { kind: 'prior', seq: 7, expectedType: 'model/exchange-accepted' }, exchangeId: 'e', actionId: 'a', attemptId: 't' } } } } as any)
  if (captured.kind !== 'captured') throw new Error('Expected a captured group')
  expect(core.resolveFactGroup(captured.group, view, 8)).toEqual([{ type: 'context/usage', version: 2, op: 'sample', checkpoint: { accepted: { acceptedSeq: 7, exchangeId: 'e', actionId: 'a', attemptId: 't' } }, seq: 8 }])
  const wrong = core.captureFactGroup({ kind: 'usage', event: { type: 'context/usage', version: 2, op: 'sample', checkpoint: { accepted: { acceptedSeq: { kind: 'prior', seq: 6, expectedType: 'model/exchange-accepted' } } } } } as any)
  if (wrong.kind !== 'captured') throw new Error('Expected a captured group')
  expect(() => core.resolveFactGroup(wrong.group, view, 8)).toThrow(/reference/)
})
