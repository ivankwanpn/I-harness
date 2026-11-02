import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it('reads physical UI counts and all nonrewound original refs under the held prefix',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-ui-reads-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'a'})
 let execution=await acquireManagedExecution(c,'a')
 try{
  const empty=execution.observe();expect([empty.hasConversationMessages,empty.turnCount,empty.todosRevision,empty.hasVisibleResultRef({kind:'legacy',id:'missing'})]).toEqual([false,0,0,false]);await execution.close()
  const ref=(i:number)=>({id:'ctx_'+i.toString(16).padStart(64,'0'),workspaceId:'w',sessionId:'a',callId:'call-'+i,label:'label-'+i,revision:(i+1).toString(16).padStart(64,'0'),bytes:i,originalBytes:i,complete:true,expiresAt:1000+i})
  await c.append('a',[{type:'turn/start'},{type:'user/message',text:'old'},{type:'todo/write',version:1,items:[]},{type:'turn/end'}])
  for(let i=0;i<16;i++)await c.append('a',[{type:'context/result-ref',ref:ref(i)}])
  await c.append('a',[{type:'rewind/point',version:1,targetTurn:0,anchorSeq:18,mode:'all',fileOps:[]}])
  await c.append('a',[{type:'context/result-ref',ref:ref(16)},{type:'todo/write',version:1,items:[]}])
  const digest='a'.repeat(64),artifact={version:1 as const,id:'ctxv1_'+digest,revision:digest,codec:'text-utf8-v1',encodedBytes:1,contentDigest:digest,completeness:'complete' as const}
  await c.append('a',[{type:'tool/call',callId:'artifact-call',name:'read',args:{}},{type:'tool/result',callId:'artifact-call',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'artifact',ref:artifact}}}])
  execution=await acquireManagedExecution(c,'a');const observation=execution.observe()
  expect([observation.hasConversationMessages,observation.turnCount,observation.todosRevision]).toEqual([true,1,2])
  for(let i=0;i<17;i++)expect(observation.hasVisibleResultRef({kind:'legacy',id:ref(i).id})).toBe(i<14||i===16)
  expect(observation.hasVisibleResultRef({kind:'managed',ref:artifact})).toBe(true)
  expect(observation.hasVisibleResultRef({kind:'managed',ref:{...artifact,revision:'b'.repeat(64)}})).toBe(false)
  const action=execution.owner.beginAction();expect((await action.captureMetadata!({type:'session/title',title:'changed',source:'user',messageSeqs:[]}).admit()).kind).toBe('committed');action.finish()
  expect(()=>observation.hasVisibleResultRef({kind:'legacy',id:ref(0).id})).toThrow();expect(()=>observation.todosRevision).toThrow()
 }finally{await execution.close();await c.close()}
},30000)
