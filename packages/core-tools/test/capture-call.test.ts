import { afterEach, expect, it, vi } from 'vitest'
import { captureToolCall } from '../src/approval/capture-call.ts'

afterEach(()=>vi.restoreAllMocks())
it.each(['map','date','bytes','undefined','sparse','cycle','class','getter','proxy'] as const)('retains the original single structuredClone behavior for %s arguments',kind=>{
  let getters=0,traps=0
  class Legacy { value=1 }
  const args=kind==='map'?new Map([['a',1]]):kind==='date'?new Date(0):kind==='bytes'?new Uint8Array([1,2]):kind==='undefined'?{value:undefined}:kind==='sparse'?new Array(3):kind==='class'?new Legacy():kind==='getter'?Object.defineProperty({},'value',{enumerable:true,get(){getters++;return 7}}):kind==='proxy'?new Proxy({value:7},{get(target,key){traps++;return Reflect.get(target,key)}}):{self:undefined as unknown}
  if(kind==='cycle')(args as {self:unknown}).self=args
  const clone=vi.spyOn(globalThis,'structuredClone')
  if(kind==='proxy')expect(()=>captureToolCall({name:'fixture',args})).toThrow()
  else {
    const actual=captureToolCall({name:'fixture',args})
    if(kind==='map')expect(actual.args).toEqual(new Map([['a',1]]))
    if(kind==='date')expect(actual.args).toEqual(new Date(0))
    if(kind==='bytes')expect(actual.args).toEqual(new Uint8Array([1,2]))
    if(kind==='undefined')expect(actual.args).toHaveProperty('value',undefined)
    if(kind==='sparse'){expect((actual.args as unknown[]).length).toBe(3);expect(Object.keys(actual.args as object)).toEqual([])}
    if(kind==='cycle')expect((actual.args as {self:unknown}).self).toBe(actual.args)
    if(kind==='class')expect(Object.getPrototypeOf(actual.args)).toBe(Object.prototype)
    if(kind==='getter')expect(actual.args).toEqual({value:7})
  }
  expect(clone).toHaveBeenCalledTimes(1)
  expect(getters).toBe(kind==='getter'?1:0);expect(traps).toBe(0)
})
it('copies ordinary source order and shared JSON data without interpreting an own __proto__ key',()=>{
  const clone=vi.spyOn(globalThis,'structuredClone'),shared={z:1,a:2}
  const call={name:'fixture',args:{...JSON.parse('{"__proto__":{"fixturePolluted":true}}'),z:shared,a:shared}}
  const actual=captureToolCall(call)
  const owned=actual.args as Record<string,unknown>
  expect(clone).not.toHaveBeenCalled()
  expect(Object.keys(owned)).toEqual(['__proto__','z','a'])
  expect(owned.z).toBe(owned.a);expect(owned.z).not.toBe(shared)
  expect(Object.getPrototypeOf(actual.args)).toBe(Object.prototype)
  expect(Object.prototype).not.toHaveProperty('fixturePolluted')
})

it.each(['function', 'toJSON', 'nonfinite'] as const)('keeps one original clone path for %s data outside ordinary JSON', kind => {
  let invoked = 0
  const args = kind === 'function' ? { value() { invoked++ } }
    : kind === 'toJSON' ? { toJSON() { invoked++; return { altered: true } } }
      : { nan: Number.NaN, infinity: Infinity }
  const clone = vi.spyOn(globalThis, 'structuredClone')
  if (kind === 'nonfinite') {
    const actual = captureToolCall({ name: 'fixture', args }).args
    expect(actual).toEqual({ nan: Number.NaN, infinity: Infinity })
  } else expect(() => captureToolCall({ name: 'fixture', args })).toThrow()
  expect(clone).toHaveBeenCalledOnce()
  expect(invoked).toBe(0)
})
