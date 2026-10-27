import { bootstrapFields, captureBootstrapInvocation, sameBootstrapData } from './bootstrap-header.ts'
import { captureBootstrapCaptureRequest, encodeBootstrapCaptureReservation, parseBootstrapCaptureReservation, validateCaptureStage } from './bootstrap-capture.ts'
import { CHILD_BOOTSTRAP_DOMAINS, captureChildBootstrapCaptureRequest, encodeChildBootstrapReservation, parseChildBootstrapReservation } from './child-bootstrap-intent.ts'
import { bootstrapHash } from '../semantic-seed.ts'
import type { ChildBootstrapCaptureRequest, OwnedCaptureInspection, OwnedCaptureReservation } from './child-bootstrap-intent.ts'
import type { BootstrapCaptureRequest, BootstrapCaptureReserveOutcome, BootstrapHeaderStage, BootstrapInvocation, BootstrapReadState, BootstrapRequest } from './bootstrap-types.ts'
import type { HeldFactOwner, IssuingFactOwner } from './fact-types.ts'
export type BootstrapRoute = {protocol:'public';invocation:BootstrapInvocation}|{protocol:'child-v1';request:ChildBootstrapCaptureRequest}
export type BootstrapCaptureRoute = {protocol:'public';request:BootstrapCaptureRequest}|{protocol:'child-v1';request:ChildBootstrapCaptureRequest}
export type ResolvedBootstrapBirth = {route:BootstrapRoute;stage:BootstrapHeaderStage}
export interface BootstrapRouteBackend {
 readState(route:BootstrapRoute):Promise<BootstrapReadState>;
 readCapture(id:string,owner:HeldFactOwner,route:BootstrapCaptureRoute):Promise<OwnedCaptureInspection>;
 reserveCapture(id:string,owner:IssuingFactOwner,route:BootstrapCaptureRoute,bytes:Uint8Array):Promise<BootstrapCaptureReserveOutcome>;
 resolveBirth(id:string):Promise<ResolvedBootstrapBirth|undefined>;
}
export function captureBootstrapRoute(input:unknown):BootstrapRoute {
 bootstrapFields(input,['protocol'],['invocation','request'])
 bootstrapFields(input,input.protocol==='public'?['protocol','invocation']:['protocol','request'])
 if(input.protocol==='public')return Object.freeze({protocol:'public',invocation:captureBootstrapInvocation(input.invocation)})
 if(input.protocol==='child-v1')return Object.freeze({protocol:'child-v1',request:captureChildBootstrapCaptureRequest(input.request)})
 throw new TypeError('Invalid bootstrap route')
}
export function captureBootstrapCaptureRoute(input:unknown):BootstrapCaptureRoute {
 bootstrapFields(input,['protocol','request'])
 if(input.protocol==='public')return Object.freeze({protocol:'public',request:captureBootstrapCaptureRequest(input.request)})
 if(input.protocol==='child-v1')return Object.freeze({protocol:'child-v1',request:captureChildBootstrapCaptureRequest(input.request)})
 throw new TypeError('Invalid bootstrap capture route')
}
export const routeInvocation=(route:BootstrapRoute):BootstrapInvocation=>route.protocol==='public'?route.invocation:route.request.invocation
export const childBootstrapPathKey=(invocation:BootstrapInvocation):string=>bootstrapHash(CHILD_BOOTSTRAP_DOMAINS.path,captureBootstrapInvocation(invocation))
export function routeForReservation(reservation:OwnedCaptureReservation):BootstrapRoute {
 return reservation.kind==='semantic-bootstrap-child-capture'?{protocol:'child-v1',request:reservation.request}:{protocol:'public',invocation:reservation.request.invocation}
}
export function encodeOwnedCaptureReservation(value:OwnedCaptureReservation):Uint8Array {return value.kind==='semantic-bootstrap-child-capture'?encodeChildBootstrapReservation(value):encodeBootstrapCaptureReservation(value)}
export function parseOwnedCaptureReservation(bytes:Uint8Array):OwnedCaptureReservation {
 if(bytes.length>262144)throw new TypeError('Capture reservation exceeds stage limit')
 const value=JSON.parse(Buffer.from(bytes).toString('utf8'))
 return value?.kind==='semantic-bootstrap-child-capture'?parseChildBootstrapReservation(bytes):parseBootstrapCaptureReservation(bytes)
}
export function validateChildCaptureStage(reservation:import('./child-bootstrap-intent.ts').ChildBootstrapReservation,stage:BootstrapHeaderStage,records?:BootstrapRequest['seed']['records']):void {
 if(!stage.headerBytes&&!records)throw new TypeError('Legacy child header required')
 const r=parseChildBootstrapReservation(encodeChildBootstrapReservation(reservation)),core=r.request.core
 const initial=core.initial,{parentSessionId:_,...tuple}=initial
 if(!sameBootstrapData(stage.captureReservation,r)||!sameBootstrapData(r.request.invocation,stage.invocation)||stage.originalTarget.kind!=='new'||!sameBootstrapData(core.metadata,stage.metadata)||!sameBootstrapData(core.lineage,stage.lineage)||!sameBootstrapData(tuple,stage.initial))throw new TypeError('Child stage binding mismatch')
 if(core.history.selection.kind==='none') {
  if(stage.seed.seedLength!==0||stage.seed.groupCount!==0||stage.seed.sourceObservation.kind!=='none'||records&&records.length!==0)throw new TypeError('Child none seed mismatch')
 }else {
  if(stage.seed.sourceObservation.kind!=='semantic'||stage.seed.seedLength<1)throw new TypeError('Child semantic source required')
  if(records){const m=records[0];if(m?.type!=='conversation/seed-manifest'||m.version!==1||!sameBootstrapData(m.selection,core.history.selection)||!('source' in core.history)||m.origins[0]?.kind!==core.history.source.kind||core.history.source.kind==='session'&&(m.origins[0]?.kind!=='session'||m.origins[0].sessionId!==core.history.source.sessionId))throw new TypeError('Child source selection mismatch')}
  const meta=JSON.parse(stage.headerBytes||'null');if(stage.headerBytes&&meta?.semanticSeed?.version!==1)throw new TypeError('Child V1 seed required')
 }
}
export function validateOwnedCaptureStage(reservation:OwnedCaptureReservation,stage:BootstrapHeaderStage,records?:BootstrapRequest['seed']['records']):void {if(reservation.kind==='semantic-bootstrap-child-capture')validateChildCaptureStage(reservation,stage,records);else if(reservation.kind==='semantic-bootstrap-capture')validateCaptureStage(reservation,stage,records);else throw new TypeError('Unknown capture reservation')}
