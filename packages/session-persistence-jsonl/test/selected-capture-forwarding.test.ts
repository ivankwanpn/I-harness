import { it,expect } from 'vitest'
import { mkdtemp,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/index.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { heldFactOwner,issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createSelectedResultsIntent,readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { encodeSelectedResultsReservation } from '../../session-persistence/src/coordinator/selected-results-intent.ts'
it('forwards selected reservation through the original backend capture ledger',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-forward-')),backend=createJsonlBackend(root),ownership=createOwnership(backend,{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),held=heldFactOwner({sessionId:'target',incarnation:'original'},ownership,()=>claim.assertHeld()),issuer=issuingFactOwner(held,()=>held.assertHeld())
 try{const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}},bytes=encodeSelectedResultsReservation({version:1,kind:'semantic-bootstrap-selected-results-capture',request:route.request})
 expect(await backend.selectedCapture.reserveSelectedCapture('target',issuer,route,bytes)).toEqual({kind:'committed-new'});expect(await readFile(selectedBootstrapPaths(join(root,'target.jsonl'),route).stage)).toEqual(Buffer.from(bytes));await backend.settleBootstrapCaptureIO!('target',held)
 }finally{await claim.release()}
})
