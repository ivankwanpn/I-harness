import {onExecutionEvent,type PluginContext} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {getManagedExecutionAdmissionWait,subscribeManagedExecution,subscribeManagedExecutionReadiness,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {ToolRegistry} from '@i-harness/core-tools'
import {createScheduleDriver} from '@i-harness/schedule/driver'
import {createScheduleTools} from '@i-harness/schedule/tools'
import {readOriginalSchedules} from '../../schedule/src/observation.ts'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {actionMetadataFacts} from './lifecycle/action-facts.ts'
import {diagnosticsFor} from '@i-harness/diagnostics'

/** Original schedule fold, metadata producer, atomic delivery and timer. */
export function mountOwnedSchedule(options:{execution:ManagedExecutionAttachment;domain:ManagedExecutionDomain;ctx:PluginContext;tools:ToolRegistry;wake(inputId:string,text:string):void;retain(close:()=>Promise<void>):void}) {
 const {execution,domain}=options
 let dirty=true,unavailable:{cause:unknown}|undefined
 const diagnostics=diagnosticsFor('session')
 const original={identity:execution.identity,observe:()=>{if(unavailable)throw unavailable.cause;const observation=execution.observe();if(dirty){readOriginalSchedules({identity:execution.identity,observe:()=>observation}).assertCurrent();dirty=false}return observation}}
 readOriginalSchedules(original).assertCurrent()
 for(const tool of createScheduleTools({original,metadata:signal=>actionMetadataFacts(execution.owner,signal)}))options.tools.register(tool)
 const driver=createScheduleDriver({sessions:()=>[domain.sessionId],original:id=>id===domain.sessionId?original:undefined,
  subscribeMutations:changed=>{const offEvents=subscribeManagedExecution(domain,event=>{if(event.type==='schedule/change')dirty=true});try{const offReady=subscribeManagedExecutionReadiness(domain,()=>{unavailable=undefined;changed(domain.sessionId)},(error,terminal)=>{unavailable={cause:error};dirty=true;try{if((error as {code?:string}|null)?.code!=='FACT_CLOSED')diagnostics.warn('[schedule] original readiness unavailable: '+String(error))}catch{}if(terminal)driver.stop()});return()=>{offReady();offEvents()}}catch(error){offEvents();throw error}},
  async deliver(delivery) {
   const action = execution.owner.beginAction()
   try {
     // A readiness notification can precede another admitted dependency.
     // Recheck before the single scheduled capture; never retry issued facts.
    for (;;) {
     const admission = getManagedExecutionAdmissionWait(domain, action, action.signal)
     if (!admission) break
     await admission
    }
    const first = delivery.due[0]!.record
    const single = delivery.due.length === 1
    const outcome = await action.facts.inputs.scheduled(delivery.dispatchEvents, {
     type: 'agent/input/admitted', version: 1, inputId: delivery.inputId, text: delivery.text,
     delivery: 'steer', intent: 'system',
     provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'session.schedule' },
     synthetic: {
      description: 'Scheduled reminder', scope: 'turn',
      display: {
       kind: 'schedule', title: single ? `Scheduled reminder: ${first.id}` : 'Scheduled reminders',
       body: single ? first.prompt : delivery.due.map(({ record }) => `${record.id}: ${record.prompt}`).join('\n\n'),
      },
     },
    })
    committedFactSeqs(outcome)
   } finally { action.finish() }
   options.wake(delivery.inputId, delivery.text)
  }
 })
 options.retain(()=>driver.close())
 onExecutionEvent(options.ctx,'agent/pre-step',async payload=>{if(typeof payload!=='object'||payload===null||(payload as {domain?:unknown}).domain!==domain)return;await driver.tick()})
 return async()=>{const result=await driver.start();if(result.deliveryErrors.length)throw new AggregateError(result.deliveryErrors,'Original schedule startup failed')}
}
