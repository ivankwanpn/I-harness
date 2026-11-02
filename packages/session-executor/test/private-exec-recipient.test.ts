import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

it('prepares an actual private Exec recipient on the original source and revokes its live fence',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-recipient-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),inputs=receivedExecutionInputsFor(execution),action=execution.owner.beginAction()
 try{
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'shell',args:{command:'actual'}}))
  committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const delivery=inputs.execDelivery(domain),prepared=await delivery.prepareExecLaunch({sessionId:'parent',callId:'call',callSeq:callSeq!,sourceId:'instance'})
  expect(inputs.execDelivery(domain)).toBe(delivery)
  expect(()=>inputs.execDelivery({...domain})).toThrow()
  expect(prepared.kind).toBe('bound');if(prepared.kind!=='bound')throw Error('original binding missing')
  expect(prepared.isCurrent()).toBe(true)
  const stop=delivery.requestClose('user-stop');expect(prepared.isCurrent()).toBe(false);await stop.settled
  expect(execution.observe().delivery.activeGeneration()).toBeUndefined()
 }finally{action.finish();await inputs.close();await coordinator.close()}
},20000)
