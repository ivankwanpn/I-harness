import { expect, it } from 'vitest'
import { childInitialCommitment, compileSemanticSeed, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest } from '@i-harness/session-persistence'
import { taskDocumentStorageContract as codec } from '../src/task/storage-contract.ts'

function fixture() {
  const initial = { inputId:'input', text:'prompt', startedAt:1, expiresAt:11, parentSessionId:'parent' }
  const payload = { invocation:{version:1 as const, operationId:'op', targetSessionId:'child', createdAt:'2026-10-27T00:00:00.000Z', requestDigest:'a'.repeat(64)}, target:{kind:'new' as const}, metadata:{}, lineage:{origin:'subagent' as const, subagentProtocolVersion:1 as const, parentSession:'parent'}, seed:compileSemanticSeed({kind:'none'}), initial }
  const core = {version:1 as const,kind:'child-bootstrap-core' as const,caller:{kind:'task' as const,taskId:'task-1',parentSessionId:'parent',toolCallId:'call'},history:{selection:{kind:'none' as const}},metadata:{},lineage:payload.lineage,initial:childInitialCommitment(payload),execution:{roleName:'worker',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent' as const},approval:'ordinary' as const}}
  const intent = createChildBootstrapRequestIntent(core,{kind:'unmanaged'})
  const request = captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...payload.invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
  return {formatVersion:3, tasks:[{id:'task-1',parentSessionId:'parent',toolCallId:'call',childSessionId:'child',agentPath:'a',description:'d',prompt:'prompt',agent:'worker',delivery:'tool',status:'accepted',timeCreated:1,childBirth:{version:1,kind:'task-child-birth',request}}], notifications:[{id:'notification-1',submissionId:'task-1',parentSessionId:'parent',messageId:'m',state:'completed',description:'',text:'',status:'pending',attempts:0,timeCreated:1}]}
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
  const getter=fixture(); Object.defineProperty(getter,'formatVersion',{get(){throw Error('getter executed')},enumerable:true}); expect(() => codec.validate(getter)).toThrow('Invalid task document version')
})
it('rejects changed target, parent, identity, and child binding shape', () => {
  for (const mutate of [
    (d:ReturnType<typeof fixture>)=>{d.tasks[0]!.childSessionId='other'},
    (d:ReturnType<typeof fixture>)=>{d.tasks[0]!.parentSessionId='other'},
    (d:ReturnType<typeof fixture>)=>{Object.assign(d.tasks[0]!,{callEventSeq:0})},
    (d:ReturnType<typeof fixture>)=>{Object.assign(d.tasks[0]!.childBirth,{extra:true})},
  ]) { const d=fixture(); mutate(d); expect(() => codec.validate(d)).toThrow() }
})
