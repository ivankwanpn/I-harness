import { createJsonlBackend } from '../src/index.ts'
import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSelectedBirth } from '../src/backend/selected-birth.ts'
it('refuses a selected header without its original stage without modifying it', async () => {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'birth-')), path=join(root,'target.jsonl')
 const raw=Buffer.from('{"formatVersion":13,"sessionId":"target","semanticSeed":{"version":3}}\n')
 await writeFile(path,raw)
 await expect(resolveSelectedBirth(path,'target',async()=>{})).rejects.toThrow()
 expect(await readFile(path)).toEqual(raw)
})
import { encodeFactBatch, decodeFactBatch } from '@i-harness/core-session'
import { codecSeed, codecPage, codecRow } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
it('resolves a complete birth with selected results without repairing a torn suffix', async () => {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'birth-')), path=join(root,'target.jsonl')
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}), invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}
 const request={invocation,core,requestIntent:intent},route={protocol:'public-results-v1' as const,request},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request}
 const seed=compileSelectedResultsSemanticSeed(codecSeed('public-completed',[codecPage([codecRow()])]))
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed},reservation)
 const meta=JSON.parse(built.headerBytes), first=encodeFactBatch('bootstrap:op:seed',meta.journal.legacyPrefixDigest,seed.records)
 const complete=encodeFactBatch('bootstrap:op:complete',decodeFactBatch(first.bytes).prefixDigest,[{type:'session/bootstrap',version:1,seq:seed.records.length,operationId:'op',manifestDigest:meta.semanticSeed.manifestDigest,dependencyClosureDigest:seed.dependencyDigest,seedLength:seed.records.length}])
 const raw=Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from(complete.bytes),Buffer.from('{')]);await writeFile(path,raw);await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes)
 const birth=await resolveSelectedBirth(path,'target',async()=>{});expect(birth?.route).toEqual(route);expect(birth?.facts.resultPageCount).toBe(1);expect(await readFile(path)).toEqual(raw)
 const observed = await createJsonlBackend(root).read('target'); expect(observed.meta?.semanticSeed?.version).toBe(3); expect(observed.events).toHaveLength(seed.records.length+1); expect(await readFile(path)).toEqual(raw)
 await unlink(selectedBootstrapPaths(path,route).stage); await expect(resolveSelectedBirth(path,'target',async()=>{})).rejects.toThrow(); expect(await readFile(path)).toEqual(raw)
 await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes); await writeFile(path,Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes)]));await expect(resolveSelectedBirth(path,'target',async()=>{})).rejects.toThrow()
})

it('refuses when the journal changes during read-only resolution', async () => {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'birth-race-')), path=join(root,'target.jsonl')
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}), invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}
 const request={invocation,core,requestIntent:intent},route={protocol:'public-results-v1' as const,request},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request}
 const seed=compileSelectedResultsSemanticSeed(codecSeed('public-completed'))
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed},reservation), meta=JSON.parse(built.headerBytes)
 const first=encodeFactBatch('bootstrap:op:seed',meta.journal.legacyPrefixDigest,seed.records), complete=encodeFactBatch('bootstrap:op:complete',decodeFactBatch(first.bytes).prefixDigest,[{type:'session/bootstrap',version:1,seq:seed.records.length,operationId:'op',manifestDigest:meta.semanticSeed.manifestDigest,dependencyClosureDigest:seed.dependencyDigest,seedLength:seed.records.length}])
 const raw=Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from(complete.bytes)])
 await writeFile(path,raw);await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes)
 let checks=0
 await expect(resolveSelectedBirth(path,'target',async()=>{if(++checks===2)await writeFile(path,Buffer.concat([raw,Buffer.from('{')]))})).rejects.toThrow()
})
