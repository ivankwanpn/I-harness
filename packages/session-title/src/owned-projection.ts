import {applySessionTitleProjection, type SessionEventView, type SessionTitleView} from '@i-harness/core-session'
import {fallbackTitle} from './index.ts'

export interface OwnedTitleSnapshot {
 revision:number
 title:Readonly<SessionTitleView>|null
 candidate:null|Readonly<{firstSeq:number;messageSeqs:readonly number[];promptText:string;fallback:string}>
}
const keys=(v:Record<string,unknown>, expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',')
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const seq=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0
export function isOwnedTitleSnapshot(value:unknown):value is OwnedTitleSnapshot {
 if(!record(value)||!keys(value,['revision','title','candidate'])||!seq(value.revision))return false
 const t=value.title
 if(t!==null&&(!record(t)||!keys(t,['title','messageSeqs','source','eventSeq'])||typeof t.title!=='string'||!Array.isArray(t.messageSeqs)||!t.messageSeqs.every(seq)||!['provider','fallback','user'].includes(t.source as string)||!seq(t.eventSeq)))return false
 const c=value.candidate
 return c===null||(record(c)&&keys(c,['firstSeq','messageSeqs','promptText','fallback'])&&seq(c.firstSeq)&&Array.isArray(c.messageSeqs)&&c.messageSeqs.length>0&&c.messageSeqs.every(seq)&&c.messageSeqs[0]===c.firstSeq&&typeof c.promptText==='string'&&c.promptText.length<=4000&&typeof c.fallback==='string')
}
export function createOwnedTitleProjection(){
 let revision=0,title:SessionTitleView|null=null,firstSeq:number|undefined,messageSeqs:number[]=[],promptText='',fallback=''
 return {
  append(event:SessionEventView,ordinal:number){
   if(event.type==='session/title'){revision++;title=applySessionTitleProjection(title,{...event,seq:event.seq??ordinal});return}
   if(event.type!=='user/message'||event.internal===true||(event as {source?:unknown}).source!==undefined)return
   revision++;const n=event.seq??ordinal
   if(firstSeq===undefined){firstSeq=n;fallback=fallbackTitle(event.text)}
   else promptText=(promptText+'\n\n').slice(0,4000)
   promptText=(promptText+event.text).slice(0,4000);messageSeqs.push(n)
  },
  snapshot():OwnedTitleSnapshot{return {revision,title:title===null?null:structuredClone(title),candidate:firstSeq===undefined?null:{firstSeq,messageSeqs:[...messageSeqs],promptText,fallback}}}
 }
}
