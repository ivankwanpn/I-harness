import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import {expect,it} from 'vitest'
import {append,deriveMessages,fromJSONL,toJSONL,migrate,type Session} from '../src/index.ts'
import {format8Fixture} from './fixtures/format8-journal.ts'
it('reads and migrates a nonempty literal format8 journal through the public codec',()=>{
 const fixture=format8Fixture(),cold=fromJSONL(fixture.raw)
 expect(cold.formatVersion).toBe(CURRENT_FORMAT_VERSION);expect(cold.events).toEqual(fixture.session.events)
 expect(fromJSONL(toJSONL(cold)).events).toEqual(cold.events)
 expect(migrate(fixture.session,CURRENT_FORMAT_VERSION).events).toEqual(fixture.session.events)
})
it('distinguishes predecessor9, unsupported future12 and invalid old-format facts',()=>{
 const fixture=format8Fixture(),current=toJSONL({...fixture.session,formatVersion:9})
 expect(fromJSONL(current).formatVersion).toBe(CURRENT_FORMAT_VERSION)
 expect(()=>fromJSONL(fixture.raw.replace('"formatVersion":8',`"formatVersion":${CURRENT_FORMAT_VERSION+1}`))).toThrow(/not supported/)
 expect(()=>migrate({...fixture.session,formatVersion:CURRENT_FORMAT_VERSION+1},CURRENT_FORMAT_VERSION)).toThrow(/unsupported/)
 expect(()=>fromJSONL(fixture.raw.replace('"formatVersion":8','"formatVersion":7'))).toThrow()
})

it('accepts literal8 for the independent in-memory migration API',()=>{const f=format8Fixture();expect(migrate(f.session,CURRENT_FORMAT_VERSION).events).toEqual(f.session.events)})

it.each([1, 2, 3, 4, 5])('preserves positional history and fork lineage in a format %s export and upgrade', formatVersion => {
 const header = {origin: 'fork', parentSession: 'parent', seedLength: 0, delegationDepth: 1}
 const events: Session['events'] = [{type: 'user/message', text: '舊訊息'}]
 const old: Session = {formatVersion, header, events}
 const text = toJSONL(old)
 const [rawHeader, first] = text.trimEnd().split('\n').map(line => JSON.parse(line))
 expect(rawHeader).toEqual({formatVersion, ...header})
 expect(first).toEqual(events[0])
 for (const upgraded of [fromJSONL(text), migrate(old, CURRENT_FORMAT_VERSION)]) {
  expect(upgraded.events[0]).not.toHaveProperty('seq')
  expect(upgraded.header).toMatchObject(header)
  append(upgraded, {type: 'assistant/message', text: 'new'})
  const exported = toJSONL(upgraded)
  const [snapshot, legacy, added] = exported.trimEnd().split('\n').map(line => JSON.parse(line))
  expect(snapshot.journal.legacyEventCount).toBe(1)
  expect(legacy).toEqual({type: 'user/message', text: '舊訊息'})
  expect(added).toMatchObject({recordKind: 'session/fact-batch', firstSeq: 1, count: 1})
  const restored = fromJSONL(exported)
  expect(restored.header).toMatchObject(header)
  expect(deriveMessages(restored)).toEqual([{role: 'user', content: '舊訊息'}, {role: 'assistant', content: 'new'}])
 }
})

it('refuses to reinterpret an unsequenced new journal suffix as legacy history', () => {
 const restored = fromJSONL('{"formatVersion":2}\n{"type":"user/message","text":"old"}\n')
 restored.events.push({type:'assistant/message',text:'unaddressed new record'})
 expect(() => toJSONL(restored)).toThrow(/sequence/)
})
