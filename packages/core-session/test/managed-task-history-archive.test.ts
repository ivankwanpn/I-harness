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
  const actual=await exportManagedTaskConversationSeed(cut,selection)
  const expected=exportConversationSeed(session,{kind:'session',sessionId:'owner'},selection)
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
  expect(await exportManagedTaskConversationSeed(cut,{kind:'all'})).toEqual(exportConversationSeed(session,{kind:'session',sessionId:'owner'},{kind:'all'}))
  expect((await exportManagedTaskConversationSeed({}, {kind:'all'})).kind).toBe('refused')
  await installed.close()
})
