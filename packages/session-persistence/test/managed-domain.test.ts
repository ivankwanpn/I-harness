import {expect,it,vi} from 'vitest'
const handoffGate=vi.hoisted(()=>({enabled:false,unknown:false,blockReconcile:false,key:undefined as string|undefined,entered:undefined as (()=>void)|undefined,wait:undefined as Promise<void>|undefined}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const actual=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...actual,createFactJournalBackend(...args:Parameters<typeof actual.createFactJournalBackend>){const backend=actual.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const handoff=Buffer.from(input[3].bytes).toString('utf8').includes('"type":"agent/delivery-handoff"');if(handoffGate.enabled&&handoff){handoffGate.entered?.();await handoffGate.wait}const result=await append(...input);if(handoff&&handoffGate.unknown&&result.kind==='committed'){handoffGate.key=input[3].key.batchId;return {kind:'unknown' as const,key:input[3].key}}return result},async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(handoffGate.blockReconcile&&input[3].key.batchId===handoffGate.key)return {kind:'unknown' as const,key:input[3].key};return reconcile(...input)}}}}})
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

it('reads exact acknowledged Code member only through its original held source',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-source-member-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});await c.create({sessionId:'b'})
 const a=await acquireManagedExecution(c,'a'),b=await acquireManagedExecution(c,'b'),ctx=createContext(),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,ctx),other=executionCore.createManagedExecutionDomain(b.identity,b.owner,ctx)
 const action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),foreignAction=b.owner.beginAction(),foreign=foreignAction.registerSettlementSource(async()=>{})
 try {
  const capture=source.code.capture({type:'code/cell',cellId:'actual',sessionId:'a',state:'interrupted'}),outcome=await capture.admit()
  const read=(executionCore as any).readManagedSourceAcknowledgedMembers
  const members=read(domain,source,capture,outcome)
  expect(members).toHaveLength(1);expect(members[0]).toMatchObject({type:'code/cell',cellId:'actual'})
  expect(()=>read(other,source,capture,outcome)).toThrow();expect(()=>read(domain,foreign,capture,outcome)).toThrow()
  expect(()=>read(domain,{...source},capture,outcome)).toThrow();expect(()=>read(domain,source,{...capture},outcome)).toThrow();expect(()=>read(domain,source,capture,{...outcome})).toThrow()
  a.revokeNewWork();expect(read(domain,source,capture,outcome)).toBe(members)
  await source.close();expect(()=>read(domain,source,capture,outcome)).toThrow()
 }finally{action.finish();foreignAction.finish();await source.close();await foreign.close();await c.close()}
},20000)

it('reads private Code state through its still-held source after new-work revocation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-state-held-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});await c.create({sessionId:'b'})
 const a=await acquireManagedExecution(c,'a'),b=await acquireManagedExecution(c,'b'),ctx=createContext(),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,ctx),other=executionCore.createManagedExecutionDomain(b.identity,b.owner,ctx)
 const action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),foreignAction=b.owner.beginAction(),foreign=foreignAction.registerSettlementSource(async()=>{})
 try {
  const store=action.captureCodeStore({type:'code/store',version:1,cellId:'c',sessionId:'a',writes:[['x',7]]});expect((await store.admit()).kind).toBe('committed')
  const terminal=source.code.capture({type:'code/cell',cellId:'c',sessionId:'a',state:'completed'});expect((await terminal.admit()).kind).toBe('committed')
  const read=(executionCore as any).readManagedSourceCodeState
  expect(read(domain,source).store).toEqual({kind:'value',entries:[['x',7]]})
  expect(()=>read(other,source)).toThrow();expect(()=>read(domain,foreign)).toThrow();expect(()=>read(domain,{...source})).toThrow()
  a.revokeNewWork();expect(read(domain,source).store).toEqual({kind:'value',entries:[['x',7]]})
  await source.close();expect(()=>read(domain,source)).toThrow()
 }finally{action.finish();foreignAction.finish();await source.close();await foreign.close();await c.close()}
},20000)

it('authenticates nested Code synthetic results with their exact held Code call capture',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-synthetic-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});const a=await acquireManagedExecution(c,'a'),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,createContext()),action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try {
  expect((await action.facts.code.record({type:'code/cell',cellId:'cell',sessionId:'a',state:'started'})).kind).toBe('committed')
  const otherSource=action.registerSettlementSource(async()=>{}),otherAction=a.owner.beginAction(),foreignSource=otherAction.registerSettlementSource(async()=>{})
  expect(()=>action.captureCodeCall!({type:'code/call',cellId:'cell',callId:'foreign',name:'read',args:{}},foreignSource)).toThrow();expect(()=>action.captureCodeCall!({type:'code/call',cellId:'cell',callId:'copy',name:'read',args:{}},{...source})).toThrow()
  const capture=(action as any).captureCodeCall({type:'code/call',cellId:'cell',callId:'nested',name:'read',args:{}},source),outcome=await capture.admit()
  if(outcome.kind!=='committed')throw Error('Code call not committed')
  const {assertManagedSyntheticResult}=await import('../../core-tools/src/registry/result-finalization.ts')
  const context={kind:'code' as const,domain,source,action,cellId:'cell',callId:'nested',name:'read',capture,outcome}
  const pin=executionCore.retainAcknowledgedExecutionMembers(capture,outcome)
  expect(()=>assertManagedSyntheticResult(context)).not.toThrow()
  expect(()=>assertManagedSyntheticResult({...context,source:otherSource})).toThrow();expect(()=>assertManagedSyntheticResult({...context,cellId:'other'})).toThrow();expect(()=>assertManagedSyntheticResult({...context,capture:{...capture}})).toThrow();expect(()=>assertManagedSyntheticResult({...context,outcome:{...outcome}})).toThrow()
  action.finish();expect(()=>assertManagedSyntheticResult(context)).not.toThrow();expect(()=>action.captureCodeCall!({type:'code/call',cellId:'cell',callId:'late',name:'read',args:{}},source)).toThrow();pin.release();await otherSource.close();otherAction.finish();await foreignSource.close()
 }finally{action.finish();await source.close();await c.close()}
},20000)











it('retires only the never-issued stale original Code handoff on Stop',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-handoff-stale-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});const a=await acquireManagedExecution(c,'a'),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,createContext()),{receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts'),inputs=receivedExecutionInputsFor(a),action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  const {committedFactSeqs}=await import('@i-harness/core-session')
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'code',name:'code_exec',args:{}}));committedFactSeqs(await action.facts.tools.dispatch('code',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const recipient=inputs.codeDelivery(domain),prepared=await recipient.prepareCodeLaunch({sessionId:'a',callId:'code',callSeq:callSeq!,cellId:'cell',sourceId:'source'});if(prepared.kind!=='bound')throw Error('Code launch unavailable')
  const captured=action.captureCodeDeliverySource({type:'agent/delivery-source',version:1,kind:'code',...prepared.binding},prepared.isCurrent),[sourceSeq]=committedFactSeqs(await captured.admit())
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();handoffGate.enabled=true;handoffGate.entered=entered.resolve;handoffGate.wait=release.promise
  const handoff=source.delivery.capture({type:'agent/delivery-handoff',version:1,kind:'code',sourceSeq:sourceSeq!}),pending=handoff.admit();await entered.promise
  const stop=recipient.requestClose('user-stop');handoffGate.enabled=false;release.resolve()
  const stale=await pending;await stop.settled
  expect(stale).toMatchObject({kind:'not-issued',code:'FACT_PRECONDITION_STALE'});expect(Object.isFrozen(stale)).toBe(true)
  const witness=await import('../src/coordinator/settlement-fact.ts');expect((witness as any).isRetiredCodeHandoff(handoff,stale)).toBe(true);expect((witness as any).isRetiredCodeHandoff({...handoff},stale)).toBe(false);expect((witness as any).isRetiredCodeHandoff(handoff,{...stale})).toBe(false)
  await expect(source.close()).resolves.toBeUndefined();expect((await a.observe().delivery.source('code','source'))?.seq).toBe(sourceSeq)
 }finally{action.finish();await source.close().catch(()=>{});await inputs.close().catch(()=>{});await c.close().catch(()=>{})}
},20000)






it('retires a Code handoff captured after its generation is closed',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-handoff-stale-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});const a=await acquireManagedExecution(c,'a'),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,createContext()),{receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts'),inputs=receivedExecutionInputsFor(a),action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  const {committedFactSeqs}=await import('@i-harness/core-session')
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'code',name:'code_exec',args:{}}));committedFactSeqs(await action.facts.tools.dispatch('code',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const recipient=inputs.codeDelivery(domain),prepared=await recipient.prepareCodeLaunch({sessionId:'a',callId:'code',callSeq:callSeq!,cellId:'cell',sourceId:'source'});if(prepared.kind!=='bound')throw Error('Code launch unavailable')
  const captured=action.captureCodeDeliverySource({type:'agent/delivery-source',version:1,kind:'code',...prepared.binding},prepared.isCurrent),[sourceSeq]=committedFactSeqs(await captured.admit())
  const stop=recipient.requestClose('user-stop');await stop.settled
  const handoff=source.delivery.capture({type:'agent/delivery-handoff',version:1,kind:'code',sourceSeq:sourceSeq!})
  const stale=await handoff.admit()
  expect(stale).toMatchObject({kind:'not-issued',code:'FACT_PRECONDITION_STALE'});expect(Object.isFrozen(stale)).toBe(true)
  const witness=await import('../src/coordinator/settlement-fact.ts');expect((witness as any).isRetiredCodeHandoff(handoff,stale)).toBe(true);expect((witness as any).isRetiredCodeHandoff({...handoff},stale)).toBe(false);expect((witness as any).isRetiredCodeHandoff(handoff,{...stale})).toBe(false)
  await expect(source.close()).resolves.toBeUndefined();expect((await a.observe().delivery.source('code','source'))?.seq).toBe(sourceSeq)
 }finally{action.finish();await source.close().catch(()=>{});await inputs.close().catch(()=>{});await c.close().catch(()=>{})}
},20000)






it('keeps an issued unknown Code handoff as the same source debt until reconciliation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-handoff-unknown-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'a'});const a=await acquireManagedExecution(c,'a'),domain=executionCore.createManagedExecutionDomain(a.identity,a.owner,createContext()),{receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts'),inputs=receivedExecutionInputsFor(a),action=a.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  const {committedFactSeqs}=await import('@i-harness/core-session')
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'code',name:'code_exec',args:{}}));committedFactSeqs(await action.facts.tools.dispatch('code',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const recipient=inputs.codeDelivery(domain),prepared=await recipient.prepareCodeLaunch({sessionId:'a',callId:'code',callSeq:callSeq!,cellId:'cell',sourceId:'source'});if(prepared.kind!=='bound')throw Error('Code launch unavailable')
  const captured=action.captureCodeDeliverySource({type:'agent/delivery-source',version:1,kind:'code',...prepared.binding},prepared.isCurrent),[sourceSeq]=committedFactSeqs(await captured.admit())
  handoffGate.unknown=true;handoffGate.blockReconcile=true
  const handoff=source.delivery.capture({type:'agent/delivery-handoff',version:1,kind:'code',sourceSeq:sourceSeq!})
  expect((await handoff.admit()).kind).toBe('unknown');const key=handoffGate.key;expect(key).toBeTruthy()
  await expect(source.close()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  const stop=recipient.requestClose('user-stop');void stop.settled.catch(()=>{})
  handoffGate.blockReconcile=false;handoffGate.unknown=false;await source.close();await recipient.settle();expect(await recipient.closeReceipt(stop.fenceId)).toMatchObject({fenceId:stop.fenceId,durability:'durable'})
  expect(handoffGate.key).toBe(key);const events=(await backend.read('a')).events;expect(events.filter(e=>e.type==='agent/delivery-handoff'&&e.kind==='code')).toHaveLength(1)
 }finally{handoffGate.unknown=false;handoffGate.blockReconcile=false;action.finish();await source.close().catch(()=>{});await inputs.close().catch(()=>{});await c.close().catch(()=>{})}
},20000)


