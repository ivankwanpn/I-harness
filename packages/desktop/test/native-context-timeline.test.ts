import {expect,it} from 'vitest'
import {projectTimeline} from '../src/renderer/session/project.ts'
it('treats native references as passive bookkeeping between streamed final prose',()=>{
  const rows=projectTimeline([
    {type:'assistant/chunk',text:'Final ',seq:0},
    {type:'context/result-ref',ref:{id:'opaque'},seq:1} as never,
    {type:'assistant/chunk',text:'answer',seq:2},
    {type:'assistant/message',text:'Final answer',seq:3},
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({kind:'message',text:'Final answer'})
})
