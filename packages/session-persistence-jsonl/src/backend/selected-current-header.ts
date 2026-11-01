import { canonicalJsonData, isStrictFactData } from '@i-harness/core-session'
import type { SelectedResultsHeaderStageV2, SessionMeta } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { selectedImmutableHeaderKeys } from './metadata-snapshot.ts'

/** Validation only; publication still requires the original resolved birth owner. */
export function assertSelectedCurrentHeader(stage:SelectedResultsHeaderStageV2,raw:unknown):SessionMeta {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!isStrictFactData(raw))throw TypeError('Invalid selected current header')
 const original=JSON.parse(stage.headerBytes),current=raw as Record<string,unknown>
 for(const key of selectedImmutableHeaderKeys){
  if(Object.hasOwn(original,key)!==Object.hasOwn(current,key))throw TypeError('Original selected header presence changed')
  if(key==='formatVersion'&&original.formatVersion===13&&current.formatVersion===14)continue
  if(canonicalJsonData(original[key])!==canonicalJsonData(current[key]))throw TypeError('Original selected header changed')
 }
 const meta=parseHeader(JSON.stringify(raw))
 if(meta.semanticSeed?.version!==3)throw TypeError('Selected birth required')
 return meta
}
