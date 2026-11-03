import { isHeldFactOwner } from './fact-owner.ts'
import type { IssuingFactOwner } from './fact-types.ts'
import { captureSelectedResultsRoute, type SelectedResultsRoute } from './selected-results-route.ts'
import { encodeSelectedResultsReservation } from './selected-results-intent.ts'
import { buildSelectedResultsHeader, reconstituteSelectedResultsStage } from './selected-results-header.ts'
import { canonicalJsonData, isStrictFactData } from '@i-harness/core-session'

type ReserveBackend={reserveSelectedCapture(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,bytes:Uint8Array):Promise<{kind:string}>}
type Captured={kind:'captured';stage:ReturnType<typeof buildSelectedResultsHeader>['stage'];seed:ReturnType<typeof reconstituteSelectedResultsStage>['seed'];stageBytes:string;headerBytes:string}
type State={kind:'initial'|'spent'|'unavailable'|'not-issued'}|Captured
/** Private capture retention only: does not create a lane or assert source authority. */
export function createSelectedCaptureAttempt(backend:ReserveBackend,issuer:IssuingFactOwner,input:SelectedResultsRoute,capture:()=>Promise<unknown>) {
 if(!isHeldFactOwner(issuer)||typeof issuer.beforeIssue!=='function'||typeof capture!=='function')throw TypeError('Original capture owner required')
 const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId
 if(issuer.owner.sessionId!==id)throw TypeError('Capture target mismatch')
 const reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request:route.request},bytes=encodeSelectedResultsReservation(reservation)
 const reserve=backend.reserveSelectedCapture
 if(typeof reserve!=='function')throw TypeError('Capture reservation unavailable')
 let state:State=Object.freeze({kind:'initial'}),flight:Promise<State>|undefined,entered=false,originalCapture:typeof capture|undefined=capture
 return Object.freeze({
  capture():Promise<State>{
   if(flight)return flight
   flight=(async()=>{
    try {
     issuer.assertHeld()
     const result=await Reflect.apply(reserve,backend,[id,issuer,route,Buffer.from(bytes)]);issuer.assertHeld()
     if(result.kind==='not-issued'){state=Object.freeze({kind:'not-issued'});flight=undefined;return state}
     if(result.kind!=='committed-new'){originalCapture=undefined;state=Object.freeze({kind:'unavailable'});return state}
     entered=true;state=Object.freeze({kind:'spent'})
     const callback=originalCapture!;originalCapture=undefined
     const input=await callback();issuer.assertHeld()
     if(!isStrictFactData(input))throw TypeError('Invalid selected capture')
     const request=JSON.parse(canonicalJsonData(input))
     const built=buildSelectedResultsHeader(request,reservation)
     const records=request.seed.records
     const checked=reconstituteSelectedResultsStage(built.stage,records)
     state=Object.freeze({kind:'captured',stage:checked.stage,seed:checked.seed,stageBytes:built.stageBytes,headerBytes:built.headerBytes});return state
    }catch{originalCapture=undefined;state=Object.freeze({kind:entered?'spent':'unavailable'});return state}
   })()
   return flight
  },
  inspect():State{return state},
 })
}
