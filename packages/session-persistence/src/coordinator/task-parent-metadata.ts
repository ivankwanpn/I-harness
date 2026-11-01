import {canonicalJsonData,isStrictFactData,CURRENT_FORMAT_VERSION} from '@i-harness/core-session'

const keys=['formatVersion','sessionId','createdAt','workspaceId','title','archived','modelSelection','semanticSeed','journal','parentSession','seedLength','delegationDepth','subagentProtocolVersion','origin']
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown)=>typeof v==='string'&&v.length>0
const integer=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
function closed(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>{return record(v)&&required.every(key=>Object.hasOwn(v,key))&&Object.keys(v).every(key=>required.includes(key)||optional.includes(key))&&Object.values(v).every(value=>value!==undefined)}
/** Closed Task writer identity, distinct from generic metadata-read currency. */
export function taskParentMetadataProjection(value:unknown):string {
 const fail=():never=>{throw TypeError('Closed original Task parent metadata required')}
 if(!isStrictFactData(value)||!closed(value,['formatVersion','sessionId','createdAt'],keys))return fail()
 if(!Number.isSafeInteger(value.formatVersion)||(value.formatVersion as number)<1||(value.formatVersion as number)>CURRENT_FORMAT_VERSION||!text(value.sessionId)||!text(value.createdAt))return fail()
 for(const key of ['workspaceId','parentSession','origin'])if(Object.hasOwn(value,key)&&!text(value[key]))return fail()
 if(Object.hasOwn(value,'title')&&typeof value.title!=='string'||Object.hasOwn(value,'archived')&&typeof value.archived!=='boolean')return fail()
 for(const key of ['seedLength','delegationDepth'])if(Object.hasOwn(value,key)&&!integer(value[key]))return fail()
 if(Object.hasOwn(value,'subagentProtocolVersion')&&value.subagentProtocolVersion!==1)return fail()
 if(Object.hasOwn(value,'modelSelection')){const model=value.modelSelection;if(!closed(model,['provider','model'],['protocol','reasoningEffort'])||!Object.values(model).every(text))return fail()}
 if(Object.hasOwn(value,'journal')){const j=value.journal;if(!closed(j,['version','legacyBodyBytes','legacyEventCount','legacyPrefixDigest','separatorBytes'])||j.version!==1||!integer(j.legacyBodyBytes)||!integer(j.legacyEventCount)||!digest(j.legacyPrefixDigest)||![0,1].includes(j.separatorBytes as number))return fail()}
 if(Object.hasOwn(value,'semanticSeed')){
  const s=value.semanticSeed,required=['version','codec','operationId','requestDigest','manifestDigest','seedDigest','dependencyDigest','seedLength','groupCount'],initial=['initialInputId','initialInputDigest','initialStartedAt','initialExpiresAt']
  if(!record(s)||!closed(s,required,[...initial,...s.version===3?['profile','results','resultPageCount']:[]])||![1,2,3].includes(s.version as number)||s.codec!==`semantic-seed-v${s.version}`||!text(s.operationId)||!['requestDigest','manifestDigest','seedDigest','dependencyDigest'].every(key=>digest(s[key]))||!integer(s.seedLength)||!integer(s.groupCount))return fail()
  if(initial.some(key=>Object.hasOwn(s,key))&&(!initial.every(key=>Object.hasOwn(s,key))||!text(s.initialInputId)||!digest(s.initialInputDigest)||!integer(s.initialStartedAt)||!integer(s.initialExpiresAt)))return fail()
  if(s.version===3){const summary=s.results;if(!['public-completed','child-history'].includes(s.profile as string)||!integer(s.resultPageCount)||!closed(summary,['version','rows','pages','digest'])||summary.version!==1||!integer(summary.rows)||!integer(summary.pages)||!digest(summary.digest))return fail()}
 }
 const {title:displayTitle,...authority}=value
 return canonicalJsonData(authority)
}
