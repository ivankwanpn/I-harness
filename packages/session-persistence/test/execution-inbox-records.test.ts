import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({views:0,ordinals:[] as number[],gate:undefined as undefined|{entered():void;wait:Promise<void>}}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){probe.views++;throw Error('Inbox lookup constructed a complete view')}}})
vi.mock('../../session-persistence-jsonl/src/backend/archive-reader.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/archive-reader.ts')>();return {...original,async readSessionArchive(...args:Parameters<typeof original.readSessionArchive>){const result=await original.readSessionArchive(...args);if(args[4]){probe.ordinals.push(args[4].ordinal);const gate=probe.gate;if(gate){probe.gate=undefined;gate.entered();await gate.wait}}return result}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
const coordinators:ReturnType<typeof composeJsonlTaskTransitionCoordinator>[]=[]
afterEach(async()=>{probe.gate=undefined;for(const c of coordinators.splice(0))await c.close();probe.views=0;probe.ordinals=[]})
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'inbox-records-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator);await coordinator.create({sessionId:'inbox'});return {root,backend,coordinator}}

it('reads the original nonresident completed and cancelled records through the same native owner without a complete view',async()=>{
 const {backend,coordinator}=await fixture()
 await coordinator.append('inbox',[
  {type:'agent/input/admitted',version:1,inputId:'completed',text:'completed body',delivery:'queue',intent:'user',clientToken:'completed-token'},
  {type:'agent/input/promoted',version:1,inputId:'completed'},
  {type:'agent/input/admitted',version:1,inputId:'cancelled',text:'cancelled body',delivery:'queue',intent:'user',clientToken:'cancelled-token'},
  {type:'agent/input/cancelled',version:1,inputId:'cancelled',reason:'user stop'},
 ])
 const execution=await acquireManagedExecution(coordinator,'inbox'),observation=execution.observe(),full=await backend.read('inbox'),before=full.events.length
 expect(observation.inbox.pending()).toEqual([])
 for(const id of ['completed','cancelled']){
  const expected=full.events.find(event=>event.type==='agent/input/admitted'&&event.inputId===id)!
  expect(await observation.inbox.admitted(id)).toEqual(expected);observation.assertCurrent()
 }
 expect(observation.inbox.lastCancellationSeq('cancelled')).toBe(full.events.at(-1)!.seq)
 expect(observation.inbox.lastCancellationSeq('completed')).toBeUndefined()
 expect(probe.ordinals).toEqual(full.events.filter(event=>event.type==='agent/input/admitted').map(event=>event.seq))
 expect(probe.views).toBe(0);expect((await backend.read('inbox')).events).toHaveLength(before)
},20000)

it('expires committed observations on live writes and refuses whole-execution Stop during the actual original descriptor read',async()=>{
 const {coordinator,backend}=await fixture(),execution=await acquireManagedExecution(coordinator,'inbox'),source=execution.owner.registerReceivedInputSource(async()=>{}),before=execution.observe()
 const admitted=await source.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'live',text:'original live body',delivery:'queue',intent:'user'}).admit();expect(admitted.kind).toBe('committed')
 await expect(before.inbox.admitted('live')).rejects.toThrow('expired')
 const current=execution.observe();expect(await current.inbox.admitted('live')).toMatchObject({inputId:'live',text:'original live body'})
 const cancelled=await source.captureCancellation({type:'agent/input/cancelled',version:1,inputId:'live'}).admit();if(cancelled.kind!=='committed')throw Error('Original cancellation failed')
 const observation=execution.observe();expect(observation.inbox.lastCancellationSeq('live')).toBe(cancelled.seqs[0]);expect(observation.inbox.pending()).toEqual([])
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.gate={entered:entered.resolve,wait:release.promise};const reading=observation.inbox.admitted('live');void reading.catch(()=>{})
 await entered.promise;execution.revokeNewWork();release.resolve();await expect(reading).rejects.toMatchObject({code:'FACT_CLOSED'})
 expect(probe.views).toBe(0);expect((await backend.read('inbox')).events.at(-1)).toMatchObject({type:'agent/input/cancelled',inputId:'live'});await source.close()
},20000)
