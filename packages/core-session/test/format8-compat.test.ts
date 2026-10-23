import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import {expect,it} from 'vitest'
import {fromJSONL,toJSONL,migrate} from '../src/index.ts'
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
