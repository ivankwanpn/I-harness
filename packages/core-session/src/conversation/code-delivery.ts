import { conversationFormatError as fail } from '../events/conversation.ts'
import { eligibleCodeTerminal, codeTerminalRef, type CodeDeliverySourceEvent, type CodeTerminalEvent } from '../events/code-delivery.ts'
import type { DeliveryKey } from '../events/delivery.ts'
export interface CodeDeliveryCandidate { source:Readonly<CodeDeliverySourceEvent>;terminal:Readonly<CodeTerminalEvent> }
export function createCodeDeliveryIndex() {
 const terminals=new Map<number,CodeTerminalEvent>(),handoffs=new Set<number>(),pending=new Map<number,CodeDeliveryCandidate>()
 return {pending:()=>[...pending.values()].map(value=>structuredClone(value)),terminal:(sourceSeq:number)=>{const value=terminals.get(sourceSeq);return value&&structuredClone(value)},stage(context:{source(seq:number):CodeDeliverySourceEvent|undefined;generation():string|undefined;received(key:DeliveryKey):boolean;member(seq:number,binding:CodeDeliverySourceEvent,type:'code/cell'|'code/store',status?:string):boolean}){
  const staged=new Map<number,CodeTerminalEvent>(),routed=new Set<number>(),candidates=new Map<number,CodeDeliveryCandidate|undefined>()
  const parent=(binding:CodeDeliverySourceEvent)=>handoffs.has(binding.seq!)||routed.has(binding.seq!)
  const refresh=(binding:CodeDeliverySourceEvent)=>{
   const end=staged.get(binding.seq!)??terminals.get(binding.seq!),ref=end&&codeTerminalRef(end)
   const key:DeliveryKey|undefined=ref&&{kind:'code',sourceNamespace:'code',recipientSessionId:binding.recipientSessionId,sourceId:binding.sourceId,resultRevision:ref.revision}
   candidates.set(binding.seq!,end&&key&&parent(binding)&&eligibleCodeTerminal(end)&&binding.generationId===context.generation()&&!context.received(key)?{source:binding,terminal:end}:undefined)
  }
  return {parent,handoff(sourceSeq:number,seq:number){const binding=context.source(sourceSeq);if(!binding||sourceSeq>=seq||binding.generationId!==context.generation()||parent(binding))fail('invalid Code parent handoff');routed.add(sourceSeq);refresh(binding)},
   end(event:CodeTerminalEvent){const binding=context.source(event.sourceSeq);if(!binding||event.sourceSeq>=event.seq!||binding.cellId!==event.cellId||staged.has(event.sourceSeq)||terminals.has(event.sourceSeq))fail('invalid or duplicate Code terminal')
    if('output'in event){const {header,footer}=event.output;if(header.sessionId!==binding.recipientSessionId||header.cellId!==binding.cellId||header.sourceId===binding.sourceId||footer.terminal.seq<=event.sourceSeq||!context.member(footer.terminal.seq,binding,'code/cell',footer.status)||footer.store&&(footer.store.seq<=event.sourceSeq||!context.member(footer.store.seq,binding,'code/store')))fail('foreign Code terminal member')}
    staged.set(event.sourceSeq,event);refresh(binding)},
   received(seq:number){candidates.set(seq,undefined)},commit(changed:boolean){for(const [seq,end] of staged)terminals.set(seq,end);for(const seq of routed)handoffs.add(seq);if(changed)pending.clear();for(const [seq,candidate] of candidates){if(candidate&&candidate.source.generationId===context.generation())pending.set(seq,candidate);else pending.delete(seq)}}}
 }}
}
