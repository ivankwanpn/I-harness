import {expect,it} from 'vitest'
import {createManagedSessionState,captureManagedHistoryCut,assertManagedHistoryCut} from '../src/managed/view.ts'
import type {Session} from '../src/events/types.ts'

it('the original immutable factory retains an append-tolerant nominal cut without source replay',()=>{
  const input:Session={formatVersion:14,events:[{type:'turn/start',seq:0},{type:'user/message',text:'original',seq:1},{type:'turn/end',seq:2}]}
  const state=createManagedSessionState(input,{sessionId:'source'}),owner={}
  state.bindOwner(owner)
  const cut=captureManagedHistoryCut(state.view,owner,'source')
  expect(()=>assertManagedHistoryCut({...cut},state.view,owner,'source')).toThrow()
  expect(()=>assertManagedHistoryCut(cut,state.view,{},'source')).toThrow()
  expect(()=>assertManagedHistoryCut(cut,state.view,owner,'foreign')).toThrow()
  const replacement=createManagedSessionState(input,{sessionId:'source'});replacement.bindOwner(owner)
  expect(()=>assertManagedHistoryCut(cut,replacement.view,owner,'source')).toThrow()
  expect(()=>captureManagedHistoryCut({...state.view},owner,'source')).toThrow()
  ;(input.events[1] as {text:string}).text='changed external source'
  expect(state.view.events[1]).toMatchObject({text:'original'})
  expect(()=>{(state.view.events[1] as {text:string}).text='changed frozen fact'}).toThrow()
  expect(()=>{(state.view.events as unknown[])[1]={}}).toThrow()
  const suffix:Session['events']=[{type:'turn/start',seq:3}]
  state.stage(suffix).install();suffix[0]={type:'turn/end',seq:3}
  expect(state.view.events[3]?.type).toBe('turn/start')
  assertManagedHistoryCut(cut,state.view,owner,'source')
  expect(()=>state.bindOwner({})).toThrow()
  assertManagedHistoryCut(cut,state.view,owner,'source')
})
