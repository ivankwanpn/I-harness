import { expect,it } from 'vitest'
import { preparePrunedResultProjection,projectPrunedResultProjection,projectToolResult } from '../src/conversation/payload.ts'
import type { ConversationPruneDependencyView } from '../src/conversation/restoration-types.ts'
import type { SessionEventView } from '../src/managed/types.ts'
it('prepared pruned slots retain exact media/head/tail without retaining or copying excluded result bodies',()=>{
 const canary='EXCLUDED-BODY-'.repeat(5000),image={mediaType:'image/png',dataBase64:'eA=='}
 const record={callId:'c',head:'head',tail:'tail',removedBytes:canary.length}
 const event:SessionEventView={type:'tool/result',seq:1,callId:'c',name:'read',output:{text:canary,images:[image]}}
 const source={id:'result',eventIndex:1,seq:1,part:'result',addressable:true},media={...source,id:'media',part:'image'}
 const reference={index:Object.freeze({eventCount:3}) as ConversationPruneDependencyView,callId:'c'}
 const slot=preparePrunedResultProjection(event,record,reference)
 expect(projectPrunedResultProjection(slot,source,media)).toEqual(projectToolResult(event,record,source,media))
 expect(JSON.stringify(slot)).not.toContain('EXCLUDED-BODY-');expect(Object.keys(slot).sort()).toEqual(['kind','callId','name','isError','media','prune','pruneSource'].sort())
 expect(slot.media).toEqual([image]);expect(slot.media).not.toBe((event.output as {images:unknown[]}).images)
})
