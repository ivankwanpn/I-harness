import * as p from '../src/index.ts'
export const guards:p.BootstrapGuards={assertCurrent(){},dependencies:{async confirm(){throw Error('none must not inspect parent')},async reconcile(){throw Error('none must not inspect parent')}}}
export function pair(text='original prompt') {
  const payload:p.BootstrapRequest={invocation:{version:1,operationId:'child',targetSessionId:'target',createdAt:'2026-10-27T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new'},metadata:{},lineage:{origin:'subagent',subagentProtocolVersion:1,parentSession:'parent'},seed:p.compileSemanticSeed({kind:'none'}),initial:{inputId:'input',text,startedAt:1,expiresAt:11,parentSessionId:'parent'}}
  const core:p.ChildBootstrapCore={version:1,kind:'child-bootstrap-core',caller:{kind:'task',taskId:'task',parentSessionId:'parent'},history:{selection:{kind:'none'}},metadata:payload.metadata,lineage:{origin:'subagent',subagentProtocolVersion:1,parentSession:'parent'},initial:p.childInitialCommitment(payload),execution:{roleName:'worker',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent'},approval:'ordinary'}}
  const intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'});payload.invocation={...payload.invocation,requestDigest:intent.requestDigest}
  return {payload,request:p.captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:payload.invocation,core,requestIntent:intent.intent})}
}
