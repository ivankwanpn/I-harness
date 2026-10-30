import { readFile } from 'node:fs/promises'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { canonicalJsonData } from '@i-harness/core-session'
import { selectedResultsPreparationFacts } from '../../../session-persistence/src/coordinator/selected-results-preparation.ts'
import { parseHeader } from '../format.ts'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'
import { ordinaryStageIO } from './bootstrap-stage.ts'
import type { StageLookupIO } from './bootstrap-stage.ts'

/** Read-only resolution: never repairs an incomplete birth or a torn suffix. */
export async function resolveSelectedBirth(path: string, id: string, assertNotDeleted: (kind: string, id: string) => Promise<void>, io: { readJournal():Promise<Buffer>; stage:StageLookupIO } = {readJournal:()=>readFile(path),stage:ordinaryStageIO(path)}) {
 await assertNotDeleted('session', id)
 let raw: Buffer
 try { raw=await io.readJournal() } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') { await assertNotDeleted('session',id); return undefined } throw error }
 const end=raw.indexOf(10)
 if(end<0 || end+1>65536) throw new TypeError('Invalid managed header')
 const meta=parseHeader(raw.subarray(0,end).toString('utf8'))
 if(!meta.semanticSeed) { await assertNotDeleted('session',id); return undefined }
 if(meta.sessionId!==id || meta.semanticSeed.version!==3 || !meta.journal) throw new TypeError('Selected birth required')
 const found=await lookupSelectedBootstrapStage(path,{kind:'header',meta},io.stage)
 if(found.kind!=='full') throw new TypeError('Original selected stage unavailable')
 const original=JSON.parse(found.stage.headerBytes)
 const expected=original.formatVersion===13 && meta.formatVersion===14 ? canonicalJsonData({...original,formatVersion:14})+'\n' : found.stage.headerBytes
 if(!raw.subarray(0,end+1).equals(Buffer.from(expected))) throw new TypeError('Original selected header changed')
 const journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta)
 const count=meta.semanticSeed.seedLength, frames=journal.frames
 const seed=frames[0], complete=frames[1]
 if(!seed || !complete || seed.prefix.eventCount!==0 || seed.batch.key.firstSeq!==0 || seed.batch.key.count!==count || seed.batch.key.batchId!==`bootstrap:${meta.semanticSeed.operationId}:seed` || complete.prefix.eventCount!==count || complete.batch.key.firstSeq!==count || complete.batch.key.count!==1 || complete.batch.key.batchId!==`bootstrap:${meta.semanticSeed.operationId}:complete`) throw new TypeError('Original selected birth frames unavailable')
 const facts=selectedResultsPreparationFacts(found.stage,journal.events.slice(0,count))
 await assertNotDeleted('session',id)
 const finalRaw=await io.readJournal()
 if(!raw.equals(finalRaw)) throw new TypeError('Selected journal changed during resolution')
 const finalStage=await lookupSelectedBootstrapStage(path,{kind:'route',route:found.route},io.stage)
 if(finalStage.kind!=='full' || !Buffer.from(found.exactBytes).equals(Buffer.from(finalStage.exactBytes))) throw new TypeError('Selected stage changed during resolution')
 await assertNotDeleted('session',id)
 return Object.freeze({protocol:'public-results-v1' as const,route:found.route,stage:found.stage,facts})
}
