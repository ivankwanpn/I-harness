import { expect, it } from 'vitest'
import { childInitialCommitment, compileSemanticSeed, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest } from '@i-harness/session-persistence'
import { taskDocumentStorageContract as storage } from '../src/task/storage-contract.ts'
import { taskV3DocumentCodec as codec } from '../src/task/v3-codec.ts'

function fixture(prompt = 'prompt') {
  const initial = { inputId:'input', text:prompt, startedAt:1, expiresAt:11, parentSessionId:'parent' }
  const payload = { invocation:{version:1 as const, operationId:'op', targetSessionId:'child', createdAt:'2026-10-27T00:00:00.000Z', requestDigest:'a'.repeat(64)}, target:{kind:'new' as const}, metadata:{}, lineage:{origin:'subagent' as const, subagentProtocolVersion:1 as const, parentSession:'parent'}, seed:compileSemanticSeed({kind:'none'}), initial }
  const core = {version:1 as const,kind:'child-bootstrap-core' as const,caller:{kind:'task' as const,taskId:'task-1',parentSessionId:'parent',toolCallId:'call'},history:{selection:{kind:'none' as const}},metadata:{},lineage:payload.lineage,initial:childInitialCommitment(payload),execution:{roleName:'worker',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent' as const},approval:'ordinary' as const}}
  const intent = createChildBootstrapRequestIntent(core,{kind:'unmanaged'})
  const request = captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...payload.invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
  return {formatVersion:3, tasks:[{id:'task-1',parentSessionId:'parent',toolCallId:'call',childSessionId:'child',agentPath:'a',description:'d',prompt,agent:'worker',delivery:'tool',status:'accepted',timeCreated:1,childBirth:{version:1,kind:'task-child-birth',request}}], notifications:[{id:'notification-1',submissionId:'task-1',parentSessionId:'parent',messageId:'m',state:'completed',description:'',text:'',status:'pending',attempts:0,timeCreated:1}]}
}
it('accepts a closed bound v3 document and preserves mutable delivery routing', () => {
  const d = fixture(); expect(() => codec.validate(d)).not.toThrow(); d.tasks[0]!.delivery='parent'; expect(() => codec.validate(d)).not.toThrow()
})
it('rejects malformed v3 rows, notifications, and non-JSON descriptors', () => {
  const mutations: ((d:ReturnType<typeof fixture>)=>void)[] = [d=>{d.tasks[0]!.prompt='changed'},d=>{d.tasks[0]!.agent='other'},d=>{d.tasks[0]!.toolCallId='other'},d=>{d.notifications[0]!.attempts=-1},d=>{d.notifications[0]!.status='bad'},d=>{Object.assign(d.notifications[0]!,{extra:true})},d=>{Object.defineProperty(d,'hidden',{value:1})},d=>{Object.defineProperty(d.tasks[0]!,'evil',{get(){throw Error('executed')},enumerable:true})},d=>{Object.assign(d.tasks[0]!,{error:undefined})}]
  for (const mutate of mutations) { const d=fixture(); mutate(d); expect(() => codec.validate(d)).toThrow() }
})
it('checks notification domains, optional absence, and parent scope', () => {
  const d=fixture(), n=d.notifications[0]!
  for (const [key,value] of [['id',''],['submissionId',''],['messageId',''],['state','running'],['status','unknown'],['attempts',1.5],['timeCreated',-1],['timeDelivered',-1],['timeWoken',Infinity],['error',1]] as const) {
    const copy=structuredClone(d); Object.assign(copy.notifications[0]!, {[key]:value}); expect(() => codec.validate(copy), key).toThrow()
  }
  expect(codec.consistency('parent',[],0,d).kind).toBe('consistent')
  n.parentSessionId='foreign'; expect(codec.consistency('parent',[],0,d).kind).toBe('recovery-required')
})
it('accepts unbound v3 and rejects extra, sparse, undefined and proxy data without executing getters', () => {
  const d=fixture(); delete (d.tasks[0] as {childBirth?: unknown}).childBirth; expect(() => codec.validate(d)).not.toThrow()
  const sparse=fixture(); sparse.notifications.length=2; expect(() => codec.validate(sparse)).toThrow()
  const extra=fixture(); Object.assign(extra.tasks[0]!,{launch:true}); expect(() => codec.validate(extra)).toThrow()
  const proxy=fixture(); proxy.tasks[0]=new Proxy(proxy.tasks[0]!,{ownKeys(){throw Error('trap executed')}}); expect(() => codec.validate(proxy)).toThrow('Invalid task snapshot')
  const getter=fixture(); Object.defineProperty(getter,'formatVersion',{get(){throw Error('getter executed')},enumerable:true}); expect(() => codec.validate(getter)).toThrow('Invalid task snapshot')
})
it('rejects changed target, parent, identity, and child binding shape', () => {
  for (const mutate of [
    (d:ReturnType<typeof fixture>)=>{d.tasks[0]!.childSessionId='other'},
    (d:ReturnType<typeof fixture>)=>{d.tasks[0]!.parentSessionId='other'},
    (d:ReturnType<typeof fixture>)=>{Object.assign(d.tasks[0]!,{callEventSeq:0})},
    (d:ReturnType<typeof fixture>)=>{Object.assign(d.tasks[0]!.childBirth,{extra:true})},
  ]) { const d=fixture(); mutate(d); expect(() => codec.validate(d)).toThrow() }
})

it('decodes v3 data but refuses manual adoption and raw persistence before effects',async()=>{
 const {createTaskRegistry}=await import('../src/task/registry.ts'),{TaskPersistence}=await import('../src/task/persistence.ts'),{stageTaskRestore}=await import('../src/task/restore-stage.ts')
 const d=fixture();let writes=0;const coordinator={async putDocument(){writes++},async putDocumentStrict(){writes++}} as never
 expect(()=>storage.validate(d)).not.toThrow();expect(stageTaskRestore(d as never,false,false).version).toBe(3)
 const registry=createTaskRegistry({stateId:'parent',coordinator});expect(()=>registry.restore(d as never)).toThrow('eligible parent');expect(registry.list()).toHaveLength(0)
 for(const strict of [false,true]){const persistence=new TaskPersistence(coordinator,'parent',strict,()=>d as never);await expect(persistence.save()).rejects.toThrow('eligible parent')}
 expect(writes).toBe(0)
})
it.each([1,2])('legacy literal%s ignored childBirth does not acquire cold authority',async version=>{
 const {createTaskRegistry}=await import('../src/task/registry.ts'),{isColdBoundChild}=await import('../src/task/cold-bindings.ts')
 const d=fixture();d.formatVersion=version;d.notifications=[];const registry=createTaskRegistry();registry.restore(d as never)
 expect(isColdBoundChild(registry,'child')).toBe(false)
})
it('migrates literal 1 only when a result-aware registry actually saves', async () => {
 const {createTaskRegistry}=await import('../src/task/registry.ts')
 let saved: unknown
 const registry=createTaskRegistry({stateId:'parent',coordinator:{async putDocument(_key:string,value:unknown){saved=structuredClone(value)}} as never,results:{capture(){throw Error('unused')},async read(){throw Error('unused')}}})
 registry.restore({formatVersion:1,tasks:[],notifications:[]})
 expect(saved).toBeUndefined()
 await registry.save()
 expect((saved as {formatVersion:number}).formatVersion).toBe(2)
})
it('rejects inherited discriminants without invoking getters or proxy traps',()=>{
 let calls=0
 const inherited=Object.assign(Object.create({formatVersion:3}),{tasks:[],notifications:[],extra:true})
 expect(()=>codec.validate(inherited)).toThrow()
 const getter=Object.assign(Object.create(Object.defineProperty({},'formatVersion',{get(){calls++;return 3}})),{tasks:[],notifications:[]})
 expect(()=>codec.validate(getter)).toThrow();expect(calls).toBe(0)
})
it('validates status and outcome domains for carried v1 rows in strict v3',()=>{
 const carried=()=>({formatVersion:3,tasks:[{id:'legacy',parentSessionId:'',agentPath:'a',description:'d',prompt:'p',agent:'worker',delivery:'tool',status:'accepted',timeCreated:1,bodyKind:'legacy-text',legacyFormatVersion:1}],notifications:[]})
 expect(()=>codec.validate(carried())).not.toThrow()
 for(const status of ['unknown',1,{},null,undefined]){const d=carried();Object.assign(d.tasks[0]!,{status});if(status===undefined)delete (d.tasks[0] as Record<string,unknown>).status;expect(()=>codec.validate(d)).toThrow()}
 for(const outcome of ['unknown',1,{},null]){const d=carried();Object.assign(d.tasks[0]!,{outcome});expect(()=>codec.validate(d)).toThrow()}
})
it('admits only strict own v3 on plain/null JSON objects without traps',()=>{
 let executions=0
 const plain=fixture(),nil=Object.assign(Object.create(null),fixture());expect(()=>codec.validate(nil)).not.toThrow()
 for(const value of [Object.assign(Object.create({}),plain),{tasks:[],notifications:[]},Object.assign(Object.create(null),{tasks:[],notifications:[]}),new Proxy(plain,{getOwnPropertyDescriptor(){executions++;throw Error('trap')},ownKeys(){executions++;throw Error('trap')}})]){
  expect(()=>codec.validate(value)).toThrow();expect(()=>storage.validate(value)).toThrow()
 }
 for(const inheritedVersion of [1,2,3]){const value=Object.assign(Object.create(Object.defineProperty({},'formatVersion',{get(){executions++;return inheritedVersion}})),{tasks:[],notifications:[]});expect(()=>storage.validate(value)).toThrow();expect(()=>codec.validate(value)).toThrow()}
 expect(executions).toBe(0)
})
it('keeps carried v1 scalar domains independent without tightening literal v1',()=>{
 const d=fixture();delete (d.tasks[0] as {childBirth?:unknown}).childBirth;Object.assign(d.tasks[0]!,{bodyKind:'legacy-text',legacyFormatVersion:1})
 for(const status of ['accepted','running','completed','error','cancelled','recovery-required'])for(const outcome of ['completed','error','cancelled','recovery-required']){const copy=structuredClone(d);Object.assign(copy.tasks[0]!,{status,outcome});expect(()=>codec.validate(copy)).not.toThrow()}
 const legacy=structuredClone(d);legacy.formatVersion=1;Object.assign(legacy.tasks[0]!,{status:'historical-value',outcome:17});expect(()=>storage.validate(legacy)).not.toThrow()
})
function rebuild(d:ReturnType<typeof fixture>,change:(core:import('@i-harness/session-persistence').ChildBootstrapCore)=>void){
 const original=d.tasks[0]!.childBirth.request,core=structuredClone(original.core);change(core)
 const intent=createChildBootstrapRequestIntent(core,original.requestIntent.project)
 d.tasks[0]!.childBirth.request=captureChildBootstrapCaptureRequest({...original,core,invocation:{...original.invocation,requestDigest:intent.requestDigest},requestIntent:intent.intent})
}
it('uses original recomputed child requests for none/task/ordinary binding boundaries',()=>{
 const changes:Parameters<typeof rebuild>[1][]=[
  core=>{core.caller={kind:'team',teamId:'team',memberId:'member'};core.lineage={origin:'team',parentSession:'parent'}},
  core=>{core.caller={kind:'approval-review',reviewId:'review'};core.lineage={origin:'approval-review',parentSession:'parent'};core.execution.approval='parent-review'},
 ]
 for(const change of changes){const d=fixture();rebuild(d,change);expect(()=>codec.validate(d)).toThrow('Invalid task child birth identity')}
 const foreign=fixture();expect(()=>rebuild(foreign,core=>{core.history={selection:{kind:'all'},source:{kind:'session',sessionId:'foreign'}}})).toThrow('Invalid child bootstrap data')
 const inherited=fixture();rebuild(inherited,core=>{core.history={selection:{kind:'all'},source:{kind:'session',sessionId:'parent'}}});expect(()=>codec.validate(inherited)).not.toThrow()
 const anonymous=fixture();delete (anonymous.tasks[0] as {toolCallId?:string}).toolCallId;rebuild(anonymous,core=>{if(core.caller.kind==='task'){delete core.caller.toolCallId;delete core.caller.callEventSeq}});expect(()=>codec.validate(anonymous)).toThrow('Invalid task child birth identity')
 const noneSource=fixture();expect(()=>rebuild(noneSource,core=>Object.assign(core.history,{source:{kind:'session',sessionId:'parent'}}))).toThrow()
 for(const field of ['requestDigest','requestCoreDigest'] as const){const d=structuredClone(fixture()),request=d.tasks[0]!.childBirth.request;if(field==='requestDigest')Object.assign(request.invocation,{requestDigest:'f'.repeat(64)});else Object.assign(request.requestIntent,{requestCoreDigest:'f'.repeat(64)});expect(()=>codec.validate(d)).toThrow()}
 const parentTarget=structuredClone(fixture());Object.assign(parentTarget.tasks[0]!.childBirth.request.invocation,{targetSessionId:'parent'});expect(()=>codec.validate(parentTarget)).toThrow()
})
it('preserves optional caller identity absence and original large prompt commitment',()=>{
 expect(()=>codec.validate(fixture('original prompt '.repeat(10000)))).not.toThrow()
 const seq=fixture();delete (seq.tasks[0] as {toolCallId?:string}).toolCallId;Object.assign(seq.tasks[0]!,{callEventSeq:0});rebuild(seq,core=>{if(core.caller.kind==='task'){delete core.caller.toolCallId;core.caller.callEventSeq=0}});expect(()=>codec.validate(seq)).not.toThrow()
 const both=fixture();Object.assign(both.tasks[0]!,{callEventSeq:0});rebuild(both,core=>{if(core.caller.kind==='task')core.caller.callEventSeq=0});expect(()=>codec.validate(both)).not.toThrow()
 const missing=fixture();delete (missing.tasks[0] as {toolCallId?:string}).toolCallId;expect(()=>codec.validate(missing)).toThrow()
})
it('accepts retained current result/publication observations through their original validators',()=>{
 const d=fixture();delete (d.tasks[0] as {childBirth?:unknown}).childBirth
 Object.assign(d.tasks[0]!,{status:'completed',outcome:'completed',result:{version:1,kind:'retained',revision:'original',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'unavailable',reason:'quota',observedEncodedBytes:1}}},publication:'unqualified',savedObservation:{status:'completed',outcome:'completed',execution:{outcome:'succeeded',dispatch:'dispatched'}}})
 expect(()=>codec.validate(d)).not.toThrow()
 Object.assign(d.tasks[0]!,{savedObservation:{status:'completed',outcome:'invented'}});expect(()=>codec.validate(d)).toThrow()
})
