import { expect,it } from 'vitest'
import { append,createSession,deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange,spyModel,autoConfig } from './fixtures/history.ts'
it.each(Array.from({length:25},(_,index)=>index))('expands event hint %i to whole shared tool units without orphaning results',async retain=>{
 const session=createSession();append(session,{type:'turn/start'});append(session,{type:'user/message',text:'current exact H'})
 for(let i=0;i<3;i++)closedExchange(session,'round-'+i,2000,true)
 const archive=session.events.slice();await createCompactionHarness({model:spyModel().model,config:autoConfig}).resetWindow(session,retain)
 expect(session.events.slice(0,archive.length)).toEqual(archive)
 const messages=deriveMessages(session),calls=new Set(messages.flatMap(message=>message.role==='assistant'?message.toolCalls?.map(call=>call.id)??[]:[]))
 for(const message of messages)if(message.role==='tool')expect(calls.has(message.toolCallId)).toBe(true)
 expect(messages.some(message=>message.content==='current exact H')).toBe(true)
})
