import {expect,it} from 'vitest'
import {fromJSONL,toJSONL,migrate} from '../src/index.ts'
import {format8Fixture} from './fixtures/format8-journal.ts'
it('reads and migrates a nonempty literal format8 journal through the public codec',()=>{
 const fixture=format8Fixture(),cold=fromJSONL(fixture.raw)
 expect(cold.formatVersion).toBe(10);expect(cold.events).toEqual(fixture.session.events)
 expect(fromJSONL(toJSONL(cold)).events).toEqual(cold.events)
 expect(migrate(fixture.session,10).events).toEqual(fixture.session.events)
})
it('distinguishes predecessor9, unsupported future11 and invalid old-format facts',()=>{
 const fixture=format8Fixture(),current=toJSONL({...fixture.session,formatVersion:9})
 expect(fromJSONL(current).formatVersion).toBe(10)
 expect(()=>fromJSONL(fixture.raw.replace('"formatVersion":8','"formatVersion":11'))).toThrow(/not supported/)
 expect(()=>migrate({...fixture.session,formatVersion:11},10)).toThrow(/unsupported/)
 expect(()=>fromJSONL(fixture.raw.replace('"formatVersion":8','"formatVersion":7'))).toThrow()
})

it('accepts literal8 for the independent in-memory migration API',()=>{const f=format8Fixture();expect(migrate(f.session,10).events).toEqual(f.session.events)})
