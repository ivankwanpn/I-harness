import {expect,it,vi} from 'vitest'
import {createSession} from '@i-harness/core-session'
import {createAgentTable,type ChildAgentEntry} from '../src/agent-table.ts'
import {createJobRegistry} from '../src/jobs.ts'
import {createOriginalTeamCleanup} from '../src/team-cleanup.ts'

it('cleans only the captured child and job and never removes a replacement',()=>{
 const table=createAgentTable(),jobs=createJobRegistry(),cancel=vi.fn(),path='lead/helper',entry:ChildAgentEntry={path,session:createSession(),sessionId:'child',status:'running',controller:new AbortController(),mailbox:[],jobId:'original-job'}
 jobs.registerJob('root','subagent','helper','original-job',undefined,cancel,{agentPath:path,sessionId:'child'});table.add(path,entry)
 const cleanup=createOriginalTeamCleanup(path,entry,{table,jobs},()=>({table,jobs}))
 expect(()=>cleanup.killJob()).toThrow('closing required');cleanup.markClosing();cleanup.markClosing();expect(entry.closing).toBe(true)
 cleanup.killJob();cleanup.killJob();expect(cancel).toHaveBeenCalledTimes(1)
 const replacement:ChildAgentEntry={...entry,controller:new AbortController(),closing:false};table.add(path,replacement)
 expect(cleanup.detach()).toBe(false);expect(cleanup.detach()).toBe(false);expect(table.get(path)).toBe(replacement)
 expect(()=>cleanup.markClosing.call({})).toThrow('receiver required')
})
