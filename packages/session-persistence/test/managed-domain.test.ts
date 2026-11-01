import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '../../core-plugin/src/index.ts'
import * as executionCore from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
it('original domains distinguish foreign source/member owners and keep past ACK evidence separate from new-work Stop',async()=>{
 const create=(executionCore as any).createManagedExecutionDomain,isDomain=(executionCore as any).isManagedExecutionDomain,isSource=(executionCore as any).isManagedExecutionSource,read=(executionCore as any).readManagedAcknowledgedMembers;expect(create).toBeTypeOf('function')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-domain-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});await c.create({sessionId:'b'});const a=await acquireManagedExecution(c,'a'),b=await acquireManagedExecution(c,'b'),ctx=createContext(),domain=create(a.identity,a.owner,ctx),other=create(b.identity,b.owner,ctx),action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 let pin:ReturnType<typeof executionCore.retainAcknowledgedExecutionMembers>|undefined
 try{expect(domain.sessionId).toBe('a');expect(isDomain(domain,ctx)).toBe(true);expect(isDomain({...domain},ctx)).toBe(false);expect(isSource(domain,source)).toBe(true);expect(isSource(other,source)).toBe(false);expect(isSource(domain,{...source})).toBe(false)
  if(!action.captureToolCall)throw Error('Original call capture absent');const capture=action.captureToolCall({type:'tool/call',callId:'actual',name:'read',args:{}}),outcome=await capture.admit(),members=read(domain,capture,outcome);expect(members).toHaveLength(1);expect(()=>read(other,capture,outcome)).toThrow();expect(()=>read(domain,{...capture},outcome)).toThrow()
  pin=executionCore.retainAcknowledgedExecutionMembers(capture,outcome);a.revokeNewWork();expect(()=>domain.assertCurrent()).toThrow();expect(read(domain,capture,outcome)).toBe(members);await source.close();expect(isSource(domain,source)).toBe(false);action.finish();pin.release();pin=undefined
 }finally{pin?.release();action.finish();await source.close();await c.close()}
},20000)
