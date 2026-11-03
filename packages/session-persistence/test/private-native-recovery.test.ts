import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it('reads the last twelve original non-rewound native recovery refs and rejects stale observations',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-recovery-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'a'})
 const ref=(i:number)=>({id:'ctx_'+i.toString(16).padStart(64,'0'),workspaceId:'w',sessionId:'a',callId:'call-'+i,label:'label-'+i,revision:(i+1).toString(16).padStart(64,'0'),bytes:i,originalBytes:i,complete:true,expiresAt:1000+i})
 for(let i=0;i<15;i++)await c.append('a',[{type:'context/result-ref',ref:ref(i)}]);await c.append('a',[{type:'rewind/point',version:1,targetTurn:0,anchorSeq:12,mode:'conversation',fileOps:[]}]);for(let i=15;i<18;i++)await c.append('a',[{type:'context/result-ref',ref:ref(i)}])
 let execution=await acquireManagedExecution(c,'a')
 try{const observation=execution.observe(),refs=await (observation as any).recentNativeRecoveryRefs();expect(refs.map((value:{id:string})=>value.id)).toEqual([...Array.from({length:9},(_,i)=>ref(i+3).id),...Array.from({length:3},(_,i)=>ref(i+15).id)]);expect(Object.isFrozen(refs)).toBe(true);const action=execution.owner.beginAction();expect((await action.captureMetadata!({type:'session/title',title:'new',source:'user',messageSeqs:[]}).admit()).kind).toBe('committed');action.finish();await expect((observation as any).recentNativeRecoveryRefs()).rejects.toThrow();await execution.close();execution=await acquireManagedExecution(c,'a');expect((await (execution.observe() as any).recentNativeRecoveryRefs()).map((value:{id:string})=>value.id)).toEqual(refs.map((value:{id:string})=>value.id))}finally{await execution.close();await c.close()}
},30000)
