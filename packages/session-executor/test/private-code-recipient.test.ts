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

it('prepares Code on the same original private recipient and refuses foreign or undispatched calls',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-code-recipient-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),inputs=receivedExecutionInputsFor(execution),action=execution.owner.beginAction()
 try{
  let fakeReads=0;const fake={...execution};Object.defineProperty(fake,'identity',{get(){fakeReads++;return execution.identity}})
  expect(()=>receivedExecutionInputsFor(fake)).toThrow();expect(fakeReads).toBe(0);expect(receivedExecutionInputsFor(execution)).toBe(inputs)
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'code-call',name:'code_exec',args:{code:'1'}}))
  const recipient=inputs.codeDelivery(domain);expect(recipient).toBe(inputs.execDelivery(domain));expect(()=>inputs.codeDelivery({...domain})).toThrow()
  expect(await recipient.prepareCodeLaunch({sessionId:'parent',callId:'code-call',callSeq:callSeq!,cellId:'cell',sourceId:'source'})).toMatchObject({kind:'unavailable',reason:'uncertified-call'})
  committedFactSeqs(await action.facts.tools.dispatch('code-call',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  expect(await recipient.prepareCodeLaunch({sessionId:'parent',callId:'other',callSeq:callSeq!,cellId:'cell',sourceId:'source'})).toMatchObject({kind:'unavailable',reason:'uncertified-call'})
  let invoked=false;const getter={sessionId:'parent',get callId(){invoked=true;return 'code-call'},callSeq:callSeq!,cellId:'cell',sourceId:'source'}
  await expect(recipient.prepareCodeLaunch(getter)).rejects.toThrow();expect(invoked).toBe(false)
  const mutable={sessionId:'parent',callId:'code-call',callSeq:callSeq!,cellId:'cell',sourceId:'source'},pending=recipient.prepareCodeLaunch(mutable);mutable.callId='other';mutable.sourceId='foreign'
  const prepared=await pending
  expect(prepared.kind).toBe('bound');if(prepared.kind!=='bound')throw Error('Original Code binding missing')
  expect(prepared.binding).toMatchObject({recipientSessionId:'parent',sourceNamespace:'code',sourceId:'source',callSeq,cellId:'cell',delivery:'tool'});expect(prepared.isCurrent()).toBe(true)
  const stop=recipient.requestClose('user-stop');expect(prepared.isCurrent()).toBe(false);await stop.settled
 }finally{action.finish();await inputs.close();await coordinator.close()}
},20000)
