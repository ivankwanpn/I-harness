import type { SessionEventView, SessionView } from '../managed/types.ts'
import { meldRewindCut, type RewindCut } from './rewind.ts'
import { validatePassiveCodeStore } from './passive-code-store/validate.ts'
import { replayPassiveCodeStore } from './passive-code-store/replay.ts'
import type { StoreEntries, StoreReplay } from './passive-code-store/types.ts'

/** State derived only from validated restore and acknowledged append units. */
export function createExecutionCodeState(header:SessionView['header'], sessionId:string) {
  type SeedRecord = Extract<SessionEventView,{type:'conversation/seed-manifest'}> | {type:'conversation/seed-group';ordinal:number;group:{extent:Extract<SessionEventView,{type:'conversation/seed-group'}>['group']['extent']}} | {type:'conversation/seed-results';page:{extent:Extract<SessionEventView,{type:'conversation/seed-results'}>['page']['extent']}}
  const seed = new Map<number, SeedRecord>()
  const records: Extract<SessionEventView,{type:'code/cell'|'code/store'}>[] = []
  const cuts: RewindCut[] = [], windows: RewindCut[] = []
  const unfinished = new Map<string,string|undefined>()
  let count=0
  return {
    append(events:readonly SessionEventView[], first:number) {
      if(first!==count) throw TypeError('Code state ordinal mismatch')
      for(const event of events) {
        if(event.seq!==count) throw TypeError('Code state ordinal mismatch')
        if(count<(header?.seedLength??0)) {
          if(event.type==='conversation/seed-manifest')seed.set(count,event)
          else if(event.type==='conversation/seed-group')seed.set(count,{type:event.type,ordinal:event.ordinal,group:{extent:event.group.extent}})
          else if(event.type==='conversation/seed-results')seed.set(count,{type:event.type,page:{extent:event.page.extent}})
        }
        if(event.type==='rewind/point' && typeof event.anchorSeq==='number' && event.anchorSeq<count) {windows.push({cutFrom:event.anchorSeq,markerSeq:count});meldRewindCut(cuts,event.anchorSeq,count)}
        if(event.type==='code/cell'||event.type==='code/store') {
          records.push(event.type==='code/cell'?{type:'code/cell',cellId:event.cellId,sessionId:event.sessionId,parentCallId:event.parentCallId,state:event.state,seq:event.seq}:event)
          if(event.type==='code/cell' && event.sessionId===sessionId) {
            if(event.state==='started'||event.state==='running') unfinished.set(event.cellId,event.parentCallId)
            else unfinished.delete(event.cellId)
          }
        }
        count++
      }
    },
    snapshot():{store:StoreReplay;unfinished:readonly {cellId:string;parentCallId?:string}[]} {
      let inherited:StoreReplay={kind:'value',entries:[]}
      if(header?.semanticSeed?.version===2 || header?.semanticSeed?.version===3 && header.semanticSeed.profile==='public-completed') {
        const manifest=seed.get(0)
        if(manifest?.type!=='conversation/seed-manifest'||!(manifest.version===2||manifest.version===3&&manifest.profile==='public-completed')) throw TypeError('Invalid semantic seed')
        const data=validatePassiveCodeStore(manifest.passive.codeStore,manifest.turns,manifest.groupCount)
        let base=data.latest,empty=false
        for(const cut of windows) if(cut.cutFrom<(header.seedLength??0)) {
          const event=seed.get(cut.cutFrom)
          let selected=event?.type==='conversation/seed-group'?data.groups[event.ordinal]:cut.cutFrom===0?undefined:data.latest
          if(header.semanticSeed.version===3&&event?.type!=='conversation/seed-group'&&cut.cutFrom!==0) {
            if(event?.type!=='conversation/seed-results'||event.page.extent.kind!=='framed') throw TypeError('Unavailable inherited result cut')
            const extent=event.page.extent
            if(extent.first!==extent.last) throw TypeError('Partial inherited result cut')
            const group=[...seed.values()].find(record=>record.type==='conversation/seed-group'&&record.group.extent.kind==='framed'&&record.group.extent.first===extent.first&&record.group.extent.last===extent.last)
            selected=group?.type==='conversation/seed-group'?data.groups[group.ordinal]:extent.first===1?undefined:data.completed.find(entry=>entry.turn===extent.first-1)?.cut
            if(selected===undefined) throw TypeError('Unavailable inherited result cut')
          }
          if(event?.type==='conversation/seed-group'&&selected===undefined) throw TypeError('Invalid semantic seed')
          if(selected===undefined) empty=true; else base=Math.min(base,selected)
        }
        inherited=empty?{kind:'value',entries:[]}:replayPassiveCodeStore(data,base)
      }
      if(inherited.kind==='limit-exceeded') return {store:inherited,unfinished:[...unfinished].map(([cellId,parentCallId])=>({cellId,...parentCallId===undefined?{}:{parentCallId}}))}
      const visible=(seq:number|undefined)=>seq===undefined||!cuts.some(c=>seq>=c.cutFrom&&seq<c.markerSeq)
      const owned=(event:{sessionId?:string;seq?:number})=>event.sessionId===sessionId||header?.parentSession!==undefined&&event.seq!==undefined&&event.seq<(header.seedLength??0)
      const key=(event:{cellId:string;sessionId?:string})=>JSON.stringify([event.sessionId??null,event.cellId])
      const terminal=new Map<string,Extract<SessionEventView,{type:'code/cell'}>>()
      for(const event of records) if(event.type==='code/cell'&&owned(event)&&visible(event.seq)) terminal.set(key(event),event)
      const values=new Map(inherited.entries)
      for(const event of records) if(event.type==='code/store'&&owned(event)&&visible(event.seq)) {
        const closed=terminal.get(key(event))
        if(closed?.state!=='completed'||event.seq!==undefined&&closed.seq!==undefined&&closed.seq<=event.seq) continue
        if(event.version!==1||!Array.isArray(event.writes)) throw Error('Invalid Code Mode store entries')
        for(const entry of event.writes) {if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string') throw Error('Invalid Code Mode store entry');values.set(entry[0],entry[1] as StoreEntries[number][1])}
      }
      return {store:{kind:'value',entries:[...values]},unfinished:[...unfinished].map(([cellId,parentCallId])=>({cellId,...parentCallId===undefined?{}:{parentCallId}}))}
    },
  }
}
