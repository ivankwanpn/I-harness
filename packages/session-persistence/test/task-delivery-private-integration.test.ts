import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({views:0}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){probe.views++;throw Error('Private source constructed a public view')}}})
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
import { inspectOriginalTaskDeliveryOpen } from '../src/coordinator/received-input-source.ts'
it('private execution requires its own acknowledged task open and retains ordinary received-source open',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-delivery-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),source=execution.owner.registerReceivedInputSource(async()=>{})
  const admitted=await source.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'human',text:'human',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}).admit();expect(admitted.kind).toBe('committed');if(admitted.kind!=='committed')throw Error('human unavailable')
  const event={type:'agent/delivery-generation' as const,version:1 as const,op:'open' as const,recipientSessionId:'parent',generationId:'generation',originInputSeq:admitted.seqs[0]!},before=execution.observe().eventCount
  expect(()=>source.captureTaskDeliveryOpen!(event,()=>true,{recipientSessionId:'foreign',sourceNamespace:'parent',sourceId:'task-1',callSeq:0})).toThrow('Invalid original task delivery open')
  expect(execution.observe().eventCount).toBe(before)
  const capture = source.captureTaskDeliveryOpen!(event, () => true, { recipientSessionId: 'parent', sourceNamespace: 'parent', sourceId: 'task-1', callSeq: 0 })
  expect(() => capture.preparation()).toThrow('not acknowledged')
  expect(execution.observe().eventCount).toBe(before)
  expect((await capture.admit()).kind).toBe('committed')
  const preparation = capture.preparation()
  expect(inspectOriginalTaskDeliveryOpen(preparation, execution.owner)?.managed?.source).toBe(source)
  expect(inspectOriginalTaskDeliveryOpen(structuredClone(preparation), execution.owner)).toBeUndefined()
  expect(execution.observe().eventCount).toBe(before + 1)
  await source.close()

  await coordinator.create({ sessionId: 'ordinary' })
  const ordinary = await acquireManagedExecution(coordinator, 'ordinary')
  const received = ordinary.owner.registerReceivedInputSource(async () => {})
  const input = await received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'ordinary-human', text: 'human', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } }).admit()
  expect(input.kind).toBe('committed')
  if (input.kind !== 'committed') throw Error('ordinary human input unavailable')
  const opened = await received.captureDeliveryOpen({ ...event, recipientSessionId: 'ordinary', originInputSeq: input.seqs[0]! }, () => true).admit()
  expect(opened.kind).toBe('committed')
  expect(ordinary.observe().eventCount).toBe(2)
  expect(probe.views).toBe(0)
  await received.close()
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},20_000)
