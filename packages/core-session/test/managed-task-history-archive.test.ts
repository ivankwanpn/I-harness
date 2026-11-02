import { expect, it } from 'vitest'
import { append, createSession, exportConversationSeed } from '../src/index.ts'
import { restoreManagedConversation, installRestoredManagedConversation } from '../src/managed/restored-view.ts'
import { exportManagedTaskConversationSeed } from '../src/conversation/seed-export.ts'

it.each([{kind:'all'} as const, {kind:'last-turns',count:1} as const])('selects archive payloads for $kind before capture', async selection => {
  const session = createSession()
  for (const text of ['old', 'new']) { append(session,{type:'turn/start'}); append(session,{type:'user/message',text}); append(session,{type:'assistant/message',text:`answer ${text}`}); append(session,{type:'turn/end'}) }
  const reads:number[] = [], owner = {}, count=session.events.length
  const candidate = await restoreManagedConversation({formatVersion:session.formatVersion,prefix:{eventCount:count,bodyBytes:0,prefixDigest:'fixture'},assertCurrent(){},async consume(accept){await accept(session.events)},async readEvent(i){return session.events[i]!},async settle(){},async close(){},appendCommitted(){throw Error('no writes')}},owner,'owner')
  const installed=installRestoredManagedConversation(candidate,owner)
  const cut=installed.reserveTaskHistory(async i=>{reads.push(i);return session.events[i]!},()=>{})
  const actual=await exportManagedTaskConversationSeed(cut.source,selection)
  const expected=exportConversationSeed(session,{kind:'session',sessionId:'owner'},selection)
  expect(expected.kind).toBe('seed')
  expect(actual).toEqual(expected)
  if(selection.kind==='last-turns') expect(reads).not.toContain(1)
  await installed.close()
})
import { literalReady } from './fixtures/format11-seed.ts'

it('preserves inherited seed metadata and rejects fabricated sources', async () => {
  const session=structuredClone(literalReady), owner={}, count=session.events.length
  const candidate=await restoreManagedConversation({formatVersion:session.formatVersion,header:session.header,prefix:{eventCount:count,bodyBytes:0,prefixDigest:'fixture'},assertCurrent(){},async consume(accept){await accept(session.events)},async readEvent(i){return session.events[i]!},async settle(){},async close(){},appendCommitted(){throw Error('no writes')}},owner,'owner')
  const installed=installRestoredManagedConversation(candidate,owner)
  const cut=installed.reserveTaskHistory(async i=>session.events[i]!,()=>{})
  const expected=exportConversationSeed(session,{kind:'session',sessionId:'owner'},{kind:'all'})
  expect(expected.kind).toBe('seed');expect(await exportManagedTaskConversationSeed(cut.source,{kind:'all'})).toEqual(expected)
  expect((await exportManagedTaskConversationSeed({}, {kind:'all'})).kind).toBe('refused')
  await installed.close()
})

it('reports structural legacy visibility without loading result bodies',async()=>{
 const session=createSession(),ref={id:'ctx_'+'a'.repeat(64),workspaceId:'w',sessionId:'creator',callId:'call',label:'label',revision:'b'.repeat(64),bytes:1,originalBytes:1,complete:true,expiresAt:2_000_000_000_000}
 append(session,{type:'user/message',text:'task'});append(session,{type:'context/result-ref',ref})
 const owner={},candidate=await restoreManagedConversation({formatVersion:session.formatVersion,prefix:{eventCount:session.events.length,bodyBytes:0,prefixDigest:'fixture'},assertCurrent(){},async consume(accept){await accept(session.events)},async readEvent(){throw Error('payload read')},async settle(){},async close(){},appendCommitted(){throw Error('no writes')}},owner,'owner')
 const installed=installRestoredManagedConversation(candidate,owner),cut=installed.reserveTaskHistory(async()=>{throw Error('payload read')},()=>{})
 expect(cut.legacy).toBe('visible');expect(cut.inheritedLegacyUnknown).toBe(false);await installed.close()
})

it('matches the public seed for a selected pruned result',async()=>{
 const session=createSession();append(session,{type:'turn/start'});append(session,{type:'user/message',text:'task'});append(session,{type:'step/start'});append(session,{type:'tool/call',callId:'a',name:'read',args:{}});append(session,{type:'tool/result',callId:'a',name:'read',output:'large original result'});append(session,{type:'step/end'});append(session,{type:'turn/end'});append(session,{type:'compaction/prune',version:1,pruned:[{callId:'a',head:'head',tail:'tail',removedBytes:10}]})
 const owner={},candidate=await restoreManagedConversation({formatVersion:session.formatVersion,prefix:{eventCount:session.events.length,bodyBytes:0,prefixDigest:'fixture'},assertCurrent(){},async consume(accept){await accept(session.events)},async readEvent(i){return session.events[i]!},async settle(){},async close(){},appendCommitted(){throw Error('no writes')}},owner,'owner')
 const installed=installRestoredManagedConversation(candidate,owner),cut=installed.reserveTaskHistory(async i=>session.events[i]!,()=>{})
 const actual=await exportManagedTaskConversationSeed(cut.source,{kind:'all'}), expected=exportConversationSeed(session,{kind:'session',sessionId:'owner'},{kind:'all'});expect(expected.kind).toBe('seed');expect(actual).toEqual(expected);await installed.close()
})
