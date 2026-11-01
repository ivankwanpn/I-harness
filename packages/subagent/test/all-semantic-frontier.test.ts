import {expect,it} from 'vitest'
import {readFileSync} from 'node:fs'
import {exportConversationSeed,createSession,append,type SessionView} from '@i-harness/core-session'
import {compileSemanticSeed} from '@i-harness/session-persistence'
import {forkTurns} from '../src/fork.ts'
import {parseTaskHistorySelection} from '../src/child/task-history.ts'

it('accepts bounded safe counts and refuses invalid counts',()=>{
  expect(parseTaskHistorySelection(1)).toBe(1)
  expect(parseTaskHistorySelection('2')).toBe(2)
  for(const value of [0,-1,Number.MAX_SAFE_INTEGER+1,'9007199254740992']) expect(()=>parseTaskHistorySelection(value)).toThrow()
})

it('projects the retained original through25 frontier without inherited delivery or a fabricated result',()=>{
  const events=JSON.parse(readFileSync(new URL('./fixtures/active-all-frontier-through25.json',import.meta.url),'utf8'))
  expect(events).toHaveLength(26);expect(events[18].type).toBe('model/exchange-accepted')
  expect(events[23].type).toBe('agent/delivery-generation');expect(events[25].type).toBe('agent/delivery-source')
  expect(()=>forkTurns(events,Infinity,14)).toThrow()
  const exported=exportConversationSeed({formatVersion:14,events} as SessionView,{kind:'session',sessionId:'parent'},{kind:'all'})
  expect(exported.kind).toBe('seed');if(exported.kind!=='seed')throw Error('Original semantic selection refused')
  expect(exported.seed.groups.flatMap(group=>group.items).some(item=>item.kind==='input'&&JSON.stringify(item).includes('run an ordinary child'))).toBe(true)
  expect(exported.seed.groups.flatMap(group=>group.items).filter(item=>item.kind==='exchange')).toHaveLength(0)
  expect(exported.seed.omissions.length).toBeGreaterThan(0)
  expect(exported.seed.artifacts).toEqual([])
  const compiled=compileSemanticSeed(exported)
  expect(compiled.records.every(event=>event.type==='conversation/seed-manifest'||event.type==='conversation/seed-group')).toBe(true)
  expect(JSON.stringify(compiled.records)).not.toContain('agent/delivery-generation')
  expect(JSON.stringify(compiled.records)).not.toContain('TOOL_FAILED')
})

it('keeps a closed signed component while omitting the whole open shared-call component',()=>{
  const source=createSession()
  append(source,{type:'turn/start'});append(source,{type:'user/message',text:'prior input'})
  append(source,{type:'step/start'});append(source,{type:'assistant/message',text:'prior answer',thinkingBlocks:[{type:'thinking',thinking:'prior reasoning',signature:'original-signature'}]})
  append(source,{type:'step/end'});append(source,{type:'turn/end'})
  append(source,{type:'turn/start'});append(source,{type:'user/message',text:'active input'})
  append(source,{type:'step/start'});append(source,{type:'tool/call',callId:'closed-sibling',name:'read',args:{}})
  append(source,{type:'tool/call',callId:'pending-spawn',name:'spawn_agent',args:{fork_turns:'all'}})
  append(source,{type:'assistant/message',text:'shared evidence'})
  append(source,{type:'tool/result',callId:'closed-sibling',name:'read',output:'not independently closed'})
  const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'})
  if(exported.kind!=='seed')throw Error('Original semantic selection refused')
  const items=exported.seed.groups.flatMap(group=>group.items)
  expect(JSON.stringify(items)).toContain('original-signature')
  expect(JSON.stringify(items)).toContain('active input')
  expect(JSON.stringify(items)).not.toContain('not independently closed')
  expect(exported.seed.omissions).toHaveLength(1)
  expect(exported.seed.artifacts).toEqual([])
  expect(compileSemanticSeed(exported).records.length).toBeGreaterThan(1)
  const one=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'last-turns',count:1})
  const two=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'last-turns',count:2})
  if(one.kind!=='seed'||two.kind!=='seed')throw Error('Bounded semantic selection refused')
  const oneItems=JSON.stringify(one.seed.groups.flatMap(group=>group.items)),twoItems=JSON.stringify(two.seed.groups.flatMap(group=>group.items))
  expect(oneItems).toContain('active input');expect(oneItems).not.toContain('original-signature')
  expect(oneItems).not.toContain('not independently closed');expect(one.seed.omissions).toHaveLength(1)
  expect(twoItems).toContain('original-signature');expect(twoItems).toContain('active input')
  expect(twoItems).not.toContain('not independently closed')
})
