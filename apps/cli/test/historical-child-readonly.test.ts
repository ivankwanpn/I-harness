import {expect,it} from 'vitest'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createSessionCoordinator,createReadOnlySessionCoordinator} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {controlledModel} from '../../../packages/session-executor/test/controlled-model.ts'
import {runHeadless} from '../src/run.ts'
import {inlineToolOutput} from './inline-tool-output.ts'
import {legacyPrefixDigest} from '@i-harness/core-session'

it('reads historical Team children without activating them through ordinary subagent tools',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'historical-child-')),coordinator=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
 try{
  const {id}=await coordinator.create()
  const child='historical-child',path='root/ordinary-looking',names=['send_message','followup_task','resume_agent','interrupt_agent','close_agent']
  // A real old stored header supplies identity. Neither the path nor the role
  // labels this row as Team, so presentation strings cannot select the guard.
  await writeFile(join(root,child+'.jsonl'),JSON.stringify({sessionId:child,formatVersion:13,journal:{version:1,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:legacyPrefixDigest(0,new Uint8Array()),separatorBytes:0},createdAt:'2026-01-01T00:00:00.000Z',origin:'team',parentSession:id,seedLength:0})+'\n')
  await coordinator.putDocument(id,{formatVersion:1,roles:[{name:'general',description:'ordinary name',systemPrompt:'ordinary prompt',tools:[]}],jobs:[],agentTable:[{path,status:'waiting',sessionId:child,roleName:'general',mailbox:[]}]})
  let calls=0
  const model=controlledModel(async function*(){const name=names[calls++];if(name)yield{type:'tool_call',call:{id:name,name,args:{target:path,message:'must remain historical'}}};else yield{type:'text/chunk',text:'history inspected'};yield{type:'end'}})
  const result=await runHeadless('inspect historical state',{workspace:root,approveAll:true,resumeSessionId:id,coordinator,model,modelPolicy:'test-mock',codeMode:{mode:'off'}})
  expect(result.exitCode,result.error).toBe(0)
  for(const name of names){
   const event=result.session?.events.find(event=>event.type==='tool/result'&&event.callId===name)
   expect(event?.type==='tool/result'?event.envelope?.execution.outcome:undefined,JSON.stringify(event)).toBe('failed')
   expect(inlineToolOutput(event)).toMatchObject({error:'Historical Team children are read-only',code:'TOOL_FAILED'})
  }
  const cold=createReadOnlySessionCoordinator(createJsonlBackend(root))
  try{const snapshot=await cold.snapshot(child);expect(snapshot.session.header?.origin).toBe('team');expect(snapshot.session.events).toEqual([])}finally{await cold.close()}
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},20000)
