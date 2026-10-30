import { canonicalJsonData, type SessionView } from '@i-harness/core-session'
import { semanticSeedFromRecords } from '@i-harness/core-session/internal/bootstrap'
import { createLegacyReadVisibility } from '../../../core-session/src/conversation/seed-retention.ts'
import { seedLayout } from '../../../core-session/src/conversation/seed-layout.ts'
import { commitment, same, checkRoot, streamHash } from './fork-codec.ts'
import type { LegacyRoot, LegacyRow } from './fork-types.ts'

/** Captures only structural row identity; grants and visibility remain with their original owners. */
export function captureSelectedPlanView(view:SessionView,rootInput:LegacyRoot,identity:{sessionId:string;createdAt:string}) {
 const root=checkRoot(rootInput),header=view.header?.semanticSeed,manifest=view.events[0]
 if(root.version!==2||!header||header.version!==3||manifest?.type!=='conversation/seed-manifest'||manifest.version!==3)throw TypeError('Original V3 seed required')
 const seed=semanticSeedFromRecords(header,view.events)
 if(seed.version!==3||identity.sessionId!==root.binding.targetSessionId||identity.createdAt!==root.binding.invocation.createdAt||seed.origins[0]?.kind!=='session'||seed.origins[0].sessionId!==root.binding.sourceSessionId||seed.origins[0].revision!==root.binding.sourceObservationDigest||!same(seed.selection,root.binding.selection)||seed.turns.total!==root.binding.totalTurns||seed.turns.unframedPrefix!==root.binding.unframedPrefix||streamHash('ih.legacy-fork.turn-domain.v1',seed.turns).digest!==root.binding.turnDomainDigest||!same(header.results,root.binding.selectedResults)||!same(manifest.results,root.binding.selectedResults)||header.seedDigest!==root.binding.semanticSeedDigest||header.manifestDigest!==root.binding.manifestDigest||header.operationId!==root.binding.invocation.operationId||header.requestDigest!==root.binding.invocation.requestDigest)throw TypeError('Selected plan seed conflict')
 const originalRoot=canonicalJsonData(root)
 let visibility:ReturnType<typeof createLegacyReadVisibility>|undefined
 return Object.freeze({*expectedLegacyRows(){
  for(const [pageOrdinal,page] of seed.results.pages.entries())for(const row of page.rows){
   if(row.protocol!=='legacy')continue
   if(row.original.kind!=='local'||row.original.event!=='context/result-ref'||row.original.slot!=='ref')throw TypeError('Unsupported selected declaration')
   yield {anchor:{kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal,rowOrdinal:row.ordinal},...commitment(row.ref),extent:row.extent,original:{sessionId:row.original.sessionId,seq:row.original.seq,part:'context/result-ref.ref' as const}}
  }
 },visible(input:LegacyRow){if(input.anchor.kind!=='seed-result')return false;visibility??=createLegacyReadVisibility(view);if(visibility.kind!=='visible')throw TypeError('Selected source visibility unavailable');const row=visibility.resultRow(input.anchor,input.extent);return !!row&&same(commitment(row.ref),{refId:input.refId,revision:input.revision,metadataDigest:input.metadataDigest,metadataEncodedBytes:input.metadataEncodedBytes,expiresAt:input.expiresAt})&&canonicalJsonData(row.original)===canonicalJsonData({kind:'local',sessionId:input.original.sessionId,seq:input.original.seq,event:'context/result-ref',slot:'ref'})},assertRoot(input:LegacyRoot){if(canonicalJsonData(input)!==originalRoot)throw TypeError('Selected plan identity changed')},row(input:LegacyRow){
  const a=input.anchor;if(a.kind!=='seed-result'||a.manifestSeq!==0)throw TypeError('Selected result anchor required')
  const seq=seedLayout(manifest).resultPageSeq(a.pageOrdinal),event=view.events[seq]
  if(!event||event.type!=='conversation/seed-results'||event.seq!==seq||event.ordinal!==a.pageOrdinal||event.manifestSeq!==0)throw TypeError('Selected result page conflict')
  const row=event.page.rows[a.rowOrdinal-event.page.firstRow]
  if(!row||row.ordinal!==a.rowOrdinal||row.protocol!=='legacy'||row.original.kind!=='local'||row.original.event!=='context/result-ref'||row.original.slot!=='ref'||!same(commitment(row.ref),{refId:input.refId,revision:input.revision,metadataDigest:input.metadataDigest,metadataEncodedBytes:input.metadataEncodedBytes,expiresAt:input.expiresAt})||!same(row.extent,input.extent)||canonicalJsonData(row.original)!==canonicalJsonData({kind:'local',sessionId:input.original.sessionId,seq:input.original.seq,event:'context/result-ref',slot:'ref'}))throw TypeError('Selected result row conflict')
  return row
 }})
}
