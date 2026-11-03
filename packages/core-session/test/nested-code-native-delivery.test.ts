import {expect,it} from 'vitest'
import {readDeliveries} from '../src/conversation/delivery.ts'

const history=()=>[
 {type:'agent/input/admitted',version:1,inputId:'human',text:'work',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'},seq:0},
 {type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'parent',generationId:'g',originInputSeq:0,seq:1},
 {type:'tool/call',name:'code_exec',callId:'outer-call',args:{},seq:2},
 {type:'tool/dispatch',callId:'outer-call',eventSeq:2,seq:3},
 {type:'agent/delivery-source',version:1,kind:'code',sourceNamespace:'code',recipientSessionId:'parent',generationId:'g',sourceId:'cell-source',callSeq:2,cellId:'cell',delivery:'tool',seq:4},
 {type:'code/call',cellId:'cell',parentCallId:'outer-call',callId:'nested',name:'shell',args:{command:'ok'},seq:5},
 {type:'code/dispatch',cellId:'cell',callId:'nested',eventSeq:5,seq:6},
 {type:'agent/delivery-source',version:1,kind:'exec',sourceNamespace:'exec',recipientSessionId:'parent',generationId:'g',sourceId:'job',callSeq:5,delivery:'parent',seq:7},
]
const read=(events:unknown[])=>readDeliveries({formatVersion:14,header:{sessionId:'parent'},events} as never)
it('certifies only the original nested call, dispatch and parent Code lineage',()=>{
 expect(read(history()).source('exec','job')).toMatchObject({callSeq:5})
 for(const mutate of [
  (events:any[])=>{events[5].cellId='foreign'},
  (events:any[])=>{events[5].parentCallId='foreign'},
  (events:any[])=>{events[6].cellId='foreign'},
  (events:any[])=>{events[6].callId='foreign'},
 ]){const events=history();mutate(events);expect(()=>read(events)).toThrow()}
})
