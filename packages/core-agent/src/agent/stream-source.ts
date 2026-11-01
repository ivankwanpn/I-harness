import {publishTransient,type SessionView,type SessionEvent,type FactPorts,type ProducerFactOutcome,type SettlementFacts} from '@i-harness/core-session'
export interface ModelStreamSource {eventCount():number;publish(event:Extract<SessionEvent,{type:'assistant/chunk'|'reasoning/chunk'|'model/activity'}>):void}
export type ModelStreamDependencies={facts?:FactPorts<ProducerFactOutcome>;sourceFacts?:SettlementFacts<ProducerFactOutcome>} & ({session:SessionView;streamSource?:never}|{session?:never;streamSource:ModelStreamSource;facts:FactPorts<ProducerFactOutcome>})
export function modelStreamSource(deps:ModelStreamDependencies):ModelStreamSource{return deps.streamSource??{eventCount:()=>deps.session.events.length,publish:event=>publishTransient(deps.session,event)}}
