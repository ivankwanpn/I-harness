import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBootstrapCaptureBackend } from '../src/backend/bootstrap-capture.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { encodeSelectedResultsReservation } from '../../session-persistence/src/coordinator/selected-results-intent.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import * as p from '@i-harness/session-persistence'

function fixture() {
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'test'},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'})
 const request={invocation:{version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},core,requestIntent:intent}
 return {protocol:'public-results-v1' as const,request}
}
it('reads selected reservation under the original held owner and preserves public reads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-read-')),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target')
 const held=heldFactOwner({sessionId:'target',incarnation:'original'},ownership,()=>claim.assertHeld())
 const backend=createBootstrapCaptureBackend(id=>join(root,id+'.jsonl'),async()=>{},root),route=fixture(),path=join(root,'target.jsonl')
 try {
  expect(await backend.readSelectedCapture('target',held,route)).toEqual({kind:'absent'})
  const reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request:route.request}
  await writeFile(selectedBootstrapPaths(path,route).stage,encodeSelectedResultsReservation(reservation))
  expect(await backend.readSelectedCapture('target',held,route)).toEqual({kind:'reserved',reservation})
  const foreign=structuredClone(route);foreign.request.invocation.operationId='other'
  expect(await backend.readSelectedCapture('target',held,foreign)).toEqual({kind:'conflict'})
  await expect(backend.readSelectedCapture('other',held,route)).rejects.toThrow()
  await expect(backend.readSelectedCapture('target',{...held},route)).rejects.toThrow()
  const core=p.readForkRequestCore({version:1,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'test'}})
  const {intent,requestDigest}=p.createBootstrapRequestIntent(core,{kind:'unmanaged'})
  const publicRequest={invocation:{...route.request.invocation,requestDigest},core,requestIntent:intent}
  expect(await backend.readBootstrapCapture('target',held,publicRequest)).toEqual({kind:'conflict'})
  await backend.settleBootstrapCaptureIO('target',held)
 } finally {await claim.release();await rm(root,{recursive:true,force:true})}
})
