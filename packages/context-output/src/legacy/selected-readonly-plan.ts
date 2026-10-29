import { resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { boundedJson, inspectImmutable, ownedPath } from '../artifact/io.ts'
import { appliedFor, canonicalRecord, checkPage, checkRoot, recordHash, same, sourceHash } from './fork-codec.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { pageName } from './fork-pages.ts'
import { transferDirectory, rowCommitment } from './observed-read.ts'
import type { ContextStore } from '../store.ts'
import type { LegacyReadObservation, LegacyRoot, LegacyRow, LegacyPageRef } from './fork-types.ts'
import { legacyResultMetadata } from '../../../core-session/src/conversation/history/result-metadata.ts'
import { SELECTED_RESULT_METADATA_LIMITS } from '../../../core-session/src/conversation/selected-results.ts'

async function exact(root:string,path:string,value:unknown,store:ContextStore,guard:()=>void) {
 const result=await inspectImmutable(root,path,Buffer.from(JSON.stringify(value)),store.retireLegacyFile);guard()
 if(!result.final||result.pending)throw Error('Original metadata is incomplete')
}
/** Read-only original plan, no sync, index preparation, repair or body reads. */
export async function readSelectedPlan(store:ContextStore,observation:LegacyReadObservation,guard:()=>void) {
 if(!observation.bootstrap)throw Error('Original bootstrap required')
 const directory=transferDirectory(store,observation.bootstrap.invocation),path=resolve(directory,'plan.json')
 await ownedPath(store.directory,path);guard();const root=checkRoot(await boundedJson(path,65536,store.retireLegacyFile));guard()
 if(root.binding.workspaceId!==store.workspaceId||!same(root.binding.invocation,observation.bootstrap.invocation)||root.binding.manifestDigest!==observation.bootstrap.manifestDigest||root.binding.semanticSeedDigest!==observation.bootstrap.seedDigest||root.binding.targetSessionId!==observation.sessionId||root.binding.targetSourceDigest!==sourceHash(observation.sourceId))throw Error('Original selected plan conflict')
 await exact(store.directory,resolve(directory,'binding.json'),canonicalRecord({version:1,kind:'legacy-fork-binding',binding:root.binding}),store,guard)
 await exact(store.directory,path,root,store,guard)
 await exact(store.directory,resolve(directory,'applied.json'),appliedFor(root),store,guard)
 if(await readSlots(store.directory,resolve(directory,'revoke'),revokedTuple(root),store.retireLegacyFile)!=='live')throw Error('Original selected grant unavailable');guard()
 return {directory,root}
}
export async function* walkSelectedPages(store:ContextStore,directory:string,root:LegacyRoot,guard:()=>void):AsyncGenerator<LegacyRow> {
 let count=0,files=0,metadataBytes=0;const folder=resolve(directory,'pages')
 async function* walk(ref:LegacyPageRef):AsyncGenerator<LegacyRow>{
  guard();const path=resolve(folder,pageName(ref));await ownedPath(directory,path);guard();const page=checkPage(await boundedJson(path,65536,store.retireLegacyFile),root.binding);guard();await exact(directory,path,page,store,guard);files++
  if(recordHash('page',page)!==ref.digest||ref.firstRow!==count)throw Error('Original page conflict')
  if(page.kind==='legacy-fork-leaf'){if(ref.level!==0||page.firstRow!==ref.firstRow||page.rows.length!==ref.rows)throw Error('Original leaf conflict');for(const row of page.rows){count++;metadataBytes+=row.metadataEncodedBytes;if(count>SELECTED_RESULT_METADATA_LIMITS.rows||!Number.isSafeInteger(metadataBytes)||metadataBytes>SELECTED_RESULT_METADATA_LIMITS.bytes)throw Error('Selected metadata limit exceeded');guard();yield row}}
  else{if(page.level!==ref.level||ref.level>53||page.children[0]!.firstRow!==ref.firstRow||page.children.reduce((n,child)=>n+child.rows,0)!==ref.rows)throw Error('Original directory conflict');for(const child of page.children)yield* walk(child)}
 }
 if(root.pages)yield* walk(root.pages)
 if(count!==root.observationCount)throw Error('Original row count conflict')
 const names=await readdir(folder);guard();if(names.length!==files||names.some(name=>!name.endsWith('.json')))throw Error('Original page inventory conflict')
}
export async function selectedRow(store:ContextStore,root:LegacyRoot,row:LegacyRow,sourceId:string,guard:()=>void) {
 const c=rowCommitment(row);if(await readSlots(store.directory,expiryBase(store.directory,c),expiredTuple(store.workspaceId,c),store.retireLegacyFile)!=='live')throw Error('Original reference expired');guard()
 const ref=legacyResultMetadata(await store.canonicalRef(c,root.binding.targetSessionId,true));guard()
 if(ref.source&&ref.source.sourceId!==sourceId)throw Error('Original source policy changed')
 return {ref,original:{kind:'local' as const,sessionId:row.original.sessionId,seq:row.original.seq,event:'context/result-ref' as const,slot:'ref' as const},extent:row.extent,anchor:row.anchor}
}
