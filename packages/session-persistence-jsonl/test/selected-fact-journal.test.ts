import { resolveSelectedBirth } from '../src/backend/selected-birth.ts'
import { issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeFactBatch, decodeFactBatch } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed, type IssuingFactOwner, type BootstrapRequest } from '@i-harness/session-persistence'
import { codecSeed, codecPage, codecRow, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createJsonlBackend } from '../src/index.ts'
import { createSelectedLaneScope, readSelectedJournalPrefix, appendSelectedOwnedBatch, reconcileSelectedOwnedBatch, confirmSelectedFrames } from '../src/backend/selected-fact-journal.ts'
function selectedSeed() {
 const exported=codecSeed('public-completed',[codecPage([codecRow()])]);exported.seed.groups=[{extent:{kind:'framed',first:1,last:1},items:[{kind:'summary',scope:'turn',extent:{kind:'framed',first:1,last:1},origins:[{origin:0,seq:1,part:'message'}],sourceProvenance:[{origin:0,kind:'summary',authority:'derived',scope:'turn'}],messages:[{role:'user',content:'summary'}]}]}];exported.seed.passive.codeStore.groups=[0];return sealCodecSeed(exported.seed)
}
it('repairs only a complete checked birth with a genuine held owner and explicit scope', async () => {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'lane-')), path=join(root,'target.jsonl'), backend=createJsonlBackend(root)
 let held:IssuingFactOwner|undefined; const append=backend.appendOwnedBatch!;backend.appendOwnedBatch=async(...args)=>{held=args[1];return append(...args)}
 const coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
 try {
 const invocation0={version:1 as const,operationId:'legacy',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest:'a'.repeat(64)}
 const req:BootstrapRequest={invocation:invocation0,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed:compileSemanticSeed({kind:'none'})}
 await coordinator.bootstrapSemanticTarget(req,{assertCurrent(){},dependencies:{async confirm(){throw Error()},async reconcile(){throw Error()}}})
 if(!held)throw Error('Missing original owner')
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}), {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={...invocation0,operationId:'op',requestDigest}
 const request={invocation,core,requestIntent:intent},route={protocol:'public-results-v1' as const,request},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request},seed=compileSelectedResultsSemanticSeed(selectedSeed())
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed},reservation),meta=JSON.parse(built.headerBytes),first=encodeFactBatch('bootstrap:op:seed',meta.journal.legacyPrefixDigest,seed.records),complete=encodeFactBatch('bootstrap:op:complete',decodeFactBatch(first.bytes).prefixDigest,[{type:'session/bootstrap',version:1,seq:seed.records.length,operationId:'op',manifestDigest:meta.semanticSeed.manifestDigest,dependencyClosureDigest:seed.dependencyDigest,seedLength:seed.records.length}])
 const raw=Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from(complete.bytes)]),torn=Buffer.concat([raw,Buffer.from('{')])
 // Remove the unrelated legacy namespace before installing the selected original stage.
 const { readdir, unlink }=await import('node:fs/promises');for(const name of await readdir(root))if(name.startsWith('target.jsonl.bootstrap-'))await unlink(join(root,name))
 await writeFile(path,torn);await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes)
 const scope=createSelectedLaneScope(held,route,built.stage)
 const prefix=await readSelectedJournalPrefix(path,'target',held,scope,async()=>{})
 expect(prefix.eventCount).toBe(seed.records.length+1);expect(await readFile(path)).toEqual(raw)
 const issuer=issuingFactOwner(held,()=>held!.assertHeld()); const next=encodeFactBatch('ordinary',prefix.prefixDigest,[{type:'plan/mode',mode:'on',seq:prefix.eventCount}]); const denied=issuingFactOwner(held,()=>{throw Object.assign(Error('stale'),{code:'FACT_PRECONDITION_STALE'})}); expect(await appendSelectedOwnedBatch(path,'target',denied,scope,prefix,next,async()=>{})).toEqual({kind:'not-issued',code:'FACT_PRECONDITION_STALE'});expect(await readFile(path)).toEqual(raw); let fenceCalls=0; expect((await appendSelectedOwnedBatch(path,'target',issuer,scope,prefix,next,async()=>{if(++fenceCalls===2)await writeFile(path,torn)})).kind).toBe('absent');expect(await readFile(path)).toEqual(torn);await writeFile(path,raw); expect((await appendSelectedOwnedBatch(path,'target',issuer,scope,prefix,next,async()=>{})).kind).toBe('committed')
 await writeFile(path,Buffer.from(built.headerBytes)); const initial={eventCount:0,bodyBytes:0,prefixDigest:meta.journal.legacyPrefixDigest}; const mutableFirst={key:{...first.key},bytes:Buffer.from(first.bytes)}; expect((await appendSelectedOwnedBatch(path,'target',issuer,scope,initial,mutableFirst,async()=>{mutableFirst.bytes.fill(0);mutableFirst.key.batchId='changed'})).kind).toBe('committed')
 expect((await reconcileSelectedOwnedBatch(path,'target',held,scope,initial,first,async()=>{})).kind).toBe('committed')
 await writeFile(path,Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes.subarray(0,10))])); expect((await reconcileSelectedOwnedBatch(path,'target',held,scope,initial,first,async()=>{})).kind).toBe('absent');expect(await readFile(path)).toEqual(Buffer.from(built.headerBytes));expect((await appendSelectedOwnedBatch(path,'target',issuer,scope,initial,first,async()=>{})).kind).toBe('committed')
 const seedPrefix={eventCount:seed.records.length,bodyBytes:first.bytes.length,prefixDigest:decodeFactBatch(first.bytes).prefixDigest}; expect((await appendSelectedOwnedBatch(path,'target',issuer,scope,seedPrefix,complete,async()=>{})).kind).toBe('committed'); expect(await readFile(path)).toEqual(raw)
 const ack=await confirmSelectedFrames(path,'target',held,scope,[{prefix:initial,batch:first},{prefix:seedPrefix,batch:complete}],async()=>{}); expect(ack.kind).toBe('committed'); if(ack.kind==='committed')expect(ack.receipts.map(r=>r.key.batchId)).toEqual(['bootstrap:op:seed','bootstrap:op:complete'])
 const resolved=await resolveSelectedBirth(path,'target',async()=>{});if(!resolved)throw Error('Missing birth');const coldScope=createSelectedLaneScope(held,resolved.route,resolved.stage);expect(await confirmSelectedFrames(path,'target',held,coldScope,[{prefix:initial,batch:first},{prefix:seedPrefix,batch:complete}],async()=>{})).toEqual(ack)
 const foreign=encodeFactBatch('bootstrap:other:complete',seedPrefix.prefixDigest,decodeFactBatch(complete.bytes).events);expect((await confirmSelectedFrames(path,'target',held,scope,[{prefix:initial,batch:first},{prefix:seedPrefix,batch:foreign}],async()=>{})).kind).toBe('conflict')
 await writeFile(path,torn);expect((await confirmSelectedFrames(path,'target',held,scope,[{prefix:initial,batch:first},{prefix:seedPrefix,batch:complete}],async()=>{})).kind).toBe('unknown');expect(await readFile(path)).toEqual(torn)
 await writeFile(path,torn); await expect(readSelectedJournalPrefix(path,'target',held,{kind:'selected-lane'} as any,async()=>{})).rejects.toThrow(); expect(await readFile(path)).toEqual(torn)
 await writeFile(selectedBootstrapPaths(path,route).stage,'{}'); await expect(readSelectedJournalPrefix(path,'target',held,scope,async()=>{})).rejects.toThrow(); expect(await readFile(path)).toEqual(torn)
 await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes)
 await writeFile(path,Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from('{')]))
 const partial=await readFile(path);await expect(readSelectedJournalPrefix(path,'target',held,scope,async()=>{})).rejects.toThrow();expect(await readFile(path)).toEqual(partial)
 }finally{await coordinator.close()}
})













