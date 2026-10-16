import { append, committedFactSeqs, isNondurableSession, type FactOwner, type SessionEvent, type SessionView } from '@i-harness/core-session'

/** Tests arrange facts through the actual owner. Detached corrupt-reader
 * fixtures remain explicitly standalone and cannot mutate a managed view. */
export async function recordFixture(owner:FactOwner,event:SessionEvent):Promise<void>{
  const action=owner.beginAction()
  try{
    const facts=action.facts
    switch(event.type){
      case 'context/result-ref':{
        let saved=false
        const source=action.registerSettlementSource(async()=>{if(!saved)throw new Error('Fixture reference requires recovery')})
        committedFactSeqs(await source.retention.capture(event).admit());saved=true;await source.close();return
      }
      case 'tool/call':committedFactSeqs(await facts.tools.call(event));return
      case 'tool/result':committedFactSeqs(await facts.tools.result(event));return
      case 'code/call':case 'code/result':case 'code/cell':case 'code/output':case 'code/store':committedFactSeqs(await facts.code.record(event));return
      case 'turn/start':case 'turn/end':case 'step/start':case 'step/end':case 'step/failed':case 'conversation/semantics':case 'assistant/chunk':case 'reasoning':case 'model/retry':committedFactSeqs(await facts.agent.lifecycle(event));return
      case 'user/message':committedFactSeqs(await facts.agent.feedback({...event,source:event.source??{kind:'plugin',plugin:'fixture'}}));return
      case 'assistant/message':committedFactSeqs(await facts.agent.auditAssistant(event));return
      case 'rewind/point':committedFactSeqs(await facts.compaction.commit([event]));return
      case 'plan/mode':case 'sandbox/mode':case 'todo/write':case 'goal/change':case 'schedule/change':case 'session/title':case 'context/budget':case 'context/recovery':case 'command/run':case 'command/done':case 'operator/run-end':committedFactSeqs(await facts.metadata.admit(event));return
      default:throw new Error(`Fixture needs a specific producer for ${event.type}`)
    }
  }finally{action.finish()}
}
export function appendStandalone(view:SessionView,event:SessionEvent):void{
  if(!isNondurableSession(view))throw new Error('Fixture must use its actual owned producer')
  append(view,event)
}
