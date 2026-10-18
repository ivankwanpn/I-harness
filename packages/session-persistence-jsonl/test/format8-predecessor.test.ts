import {expect,it,vi} from 'vitest'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createJsonlBackend} from '../src/index.ts'
import {createSessionCoordinator} from '../../session-persistence/src/index.ts'
import {readGenerationActions} from '@i-harness/core-session'
import {format8Fixture} from '../../core-session/test/fixtures/format8-journal.ts'
it.each([false,true])('upgrades literal8 header only, preserves its journal and reopens for one owned append (explicit=%s)',async explicit=>{
 const fixture=format8Fixture(),root=await mkdtemp(join(tmpdir(),'ih-fix1-format8-')),path=join(root,'legacy.jsonl');await writeFile(path,fixture.raw)
 const backend=createJsonlBackend(root),before=await backend.read('legacy'),fetch=vi.fn(()=>{throw Error('network forbidden')});vi.stubGlobal('fetch',fetch)
 const coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
 try {
  expect(before.version).toBe(8);expect(before.events).toEqual(fixture.session.events)
  if(explicit)expect((await backend.upgradeSessionFormat!('legacy',8,9)).formatVersion).toBe(9)
  const document=await coordinator.openManagedDocument('legacy'),upgraded=await readFile(path,'utf8'),header=JSON.parse(upgraded.slice(0,upgraded.indexOf('\n')))
  expect(header).toEqual({...fixture.header,formatVersion:9});expect(upgraded.slice(upgraded.indexOf('\n')+1)).toBe(fixture.body)
  expect(document.view.events).toEqual(before.events)
  expect(readGenerationActions(document.view.events)).toEqual(readGenerationActions(before.events))
  const prior=readGenerationActions(document.view.events)[0]!
  expect(prior.attempts).toHaveLength(1);expect(prior.attempts[0]!.disposition).toBeUndefined()
  await document.metadata.admit({type:'session/title',title:'continued safely',messageSeqs:[],source:'fallback'})
  const after=await backend.read('legacy');expect(after.version).toBe(9);expect(after.events.slice(0,before.events.length)).toEqual(before.events)
  expect(after.events.at(-1)).toMatchObject({type:'session/title',title:'continued safely'})
  expect((await readFile(path,'utf8')).slice(upgraded.indexOf('\n')+1).startsWith(fixture.body)).toBe(true)
  expect(readGenerationActions(after.events)).toEqual(readGenerationActions(before.events));expect(fetch).not.toHaveBeenCalled()
  await expect(backend.upgradeSessionFormat!('legacy',10,9)).rejects.toThrow()
  const future=JSON.stringify({...fixture.header,formatVersion:10,sessionId:'future'})+'\n'+fixture.body
  await writeFile(join(root,'future.jsonl'),future)
  await expect(coordinator.openManagedDocument('future')).rejects.toThrow(/newer|Future|upgrade/i)
  expect(await readFile(join(root,'future.jsonl'),'utf8')).toBe(future)
 }finally{await coordinator.close();vi.unstubAllGlobals()}
})
