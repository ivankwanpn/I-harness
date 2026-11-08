import {inspectOriginalTaskDeliveryOpen,inspectManagedTaskDeliveryOpen} from '@i-harness/session-persistence/internal/retained-inspection'
import {inspectOriginalSpawnStart,inspectManagedSpawnStart,type OriginalSpawnStart} from '../tools/spawn-source.ts'
import { assertOriginalTaskCaller,originalTaskCallerGuard, type OriginalTaskCaller, type ToolExecutionOwnerContext } from '@i-harness/core-tools/internal/task-caller'
import {runOriginalCurrentnessRead,runOpaqueCurrentnessRead,callOriginalCurrentnessMethod,propagateOriginalCurrentnessReader} from '../../../core-session/src/managed/currentness-guards.ts'
import type { TaskRecord, TaskRegistry, TaskSubmissionInput, TaskChildBirthBinding } from './types.ts'
import type { SubagentRole } from '../roles.ts'
import type { OwnedTaskSave } from './persistence.ts'
import { captureTaskSnapshot } from '@i-harness/session-persistence/internal/task-document-operations'
import {canonicalJsonData} from '@i-harness/core-session'
import {captureTaskChildHistory,inspectTaskChildSource,managedTaskHistoryFor,parseTaskHistorySelection,type OriginalTaskChildHistory} from '../child/task-history.ts'
export interface TaskLaunchSlot {
 readonly history?:OriginalTaskChildHistory
 readonly task: Readonly<TaskRecord>; readonly caller: OriginalTaskCaller; readonly role: Readonly<SubagentRole>; readonly flight: Promise<TaskLaunchResult>
 readonly accepted: Promise<void>
 acknowledgeDelivery(preparation:object):void
 acknowledgeStart(receipt:OriginalSpawnStart):void
 assertSourceCut():void
 captureSelection<T>(read:()=>T):T
 keep(cleanup: {close():Promise<void>}): void
 keepRecovery(cleanup:{close():Promise<void>}):void
 beforeResultIssue(before:()=>Promise<void>):void
 retainResult():Promise<void>
 start(prepare: () => Promise<TaskLaunchResult>): void
 assertCurrent(): void
 published(): void
 retainPublication(phase:{kind:'agent'|'job'|'entry'|'run';value:object}):void
 bind(birth: TaskChildBirthBinding): Promise<void>
 assertBinding(): void
 consumeBinding(): void
 retryBinding(): Promise<void>
 retire(cause: unknown): void
}
export interface TaskLaunchResult {agent_path:string;job_id:string;task_id:string;status?:string;outcome?:string;resultText?:string;error?:string;message?:string;timed_out?:boolean;yielded?:true;yield_reason?:'user-steer'|'background-event'}
export interface TaskLaunchPort { inspect(id:string): Readonly<{flight:Promise<TaskLaunchResult>;task:Readonly<TaskRecord>}>|undefined; admit(caller:OriginalTaskCaller,role:SubagentRole):{kind:'new'|'same';slot:TaskLaunchSlot}; retireTask(id:string,cause:unknown):void; retireAll(cause:unknown):void; close():Promise<void>; assertSnapshot():void }
const issued=new WeakSet<TaskLaunchSlot>()
export function assertOriginalTaskLaunchSlot(slot:TaskLaunchSlot){if(!issued.has(slot))throw TypeError('Foreign task launch slot');slot.assertCurrent()}
const ports=new WeakMap<TaskRegistry,TaskLaunchPort>()
export function taskLaunchPortFor(registry:TaskRegistry):TaskLaunchPort {const port=ports.get(registry);if(!port)throw Error('Original task launch owner unavailable');return port}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
export function createTaskLaunchPort(registry:TaskRegistry,context:ToolExecutionOwnerContext|{readonly kind:'managed-execution';readonly domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;readonly context:import('@i-harness/core-plugin').PluginContext;readonly sessionId:string},hooks:{current(record?:TaskRecord):void;insert(input:TaskSubmissionInput):{record:TaskRecord;inserted:boolean};protect(record:TaskRecord):void;accept(record:TaskRecord):Promise<void>;bind(record:TaskRecord,birth:TaskChildBirthBinding):OwnedTaskSave;beforeResultIssue(record:TaskRecord,before:()=>Promise<void>):void;retainResult(record:TaskRecord):Promise<void>}):TaskLaunchPort {
 let stopped: {cause:unknown}|undefined
 const slots=new Map<TaskRecord,TaskLaunchSlot>(),states=new Map<TaskLaunchSlot,{retire(cause:unknown):void;close():Promise<void>;snapshot():void}>()
 const orphanHistories=new Set<NonNullable<ReturnType<typeof managedTaskHistoryFor>>['reservation']>()
 const unassociated=()=>{}
 const checkCaller=(caller:OriginalTaskCaller)=>{const guard=originalTaskCallerGuard(caller)??unassociated;return runOriginalCurrentnessRead(guard,()=>{if(stopped)throw stopped.cause;assertOriginalTaskCaller(caller);callOriginalCurrentnessMethod(guard,hooks,'current',[]);runOpaqueCurrentnessRead(guard,()=>{const actual=caller.context;const same='kind'in context?'kind'in actual&&actual.domain===context.domain:!('kind'in actual)&&actual.view===context.view&&actual.factOwner===context.factOwner;if(!same||actual.context!==context.context||caller.identity.parentSessionId!==context.sessionId)throw Error('Foreign original task mount')})})}
 const port:TaskLaunchPort={
  inspect(id){for(const [task,slot]of slots)if(task.id===id)return Object.freeze({flight:slot.flight,task});return undefined},
  admit(caller,role){
   if(this!==port)throw TypeError('Foreign task launch port');checkCaller(caller)
   const args=caller.call.args as {task_name:string;message:string;agent_type?:string;fork_turns?:unknown;background?:boolean}
   parseTaskHistorySelection(args.fork_turns)
   if(role.name==='reviewer'||caller.identity.callEventSeq===undefined&&!caller.identity.toolCallId)throw Error('Unsupported task launch population')
   if(role.name!==(args.agent_type??'general'))throw Error('Original task role mismatch')
   for(const old of slots.values())if(canonicalJsonData(old.caller.identity)===canonicalJsonData(caller.identity)){
    if(canonicalJsonData(old.caller.call)!==canonicalJsonData(caller.call))throw Error('Original caller identity conflict')
    caller.consume();return {kind:'same',slot:old}
   }
   const intent=freeze(captureTaskSnapshot({identity:caller.identity,agentPath:'root/'+args.task_name,description:args.task_name,prompt:args.message,agent:role.name,delivery:args.background===false?'tool':'parent'}) as TaskSubmissionInput)
   const roleIntent=freeze(captureTaskSnapshot(role) as SubagentRole),completion=Promise.withResolvers<TaskLaunchResult>()
   void completion.promise.catch(()=>{})
   const setup:{close():Promise<void>;closed:boolean}[]=[]
   const history=captureTaskChildHistory(caller),managedHistory=history&&managedTaskHistoryFor(history)
   if(managedHistory)setup.push({close:managedHistory.reservation.close.bind(managedHistory.reservation),closed:false})
   const recovery:{close():Promise<void>;closed:boolean}[]=[]
   const publication=new Map<string,object>()
   let selection:{value:unknown}|{cause:unknown}|undefined
   let bindingIntent: TaskChildBirthBinding | undefined,removeAbort=()=>{}
   let preparation:Promise<void>|undefined,published=false,startReceipt:OriginalSpawnStart|undefined,deliveryPreparation:object|undefined
   let task:TaskRecord,accepted:Promise<void>=Promise.resolve(),binding:OwnedTaskSave|undefined,started=false,retired:{cause:unknown}|undefined,consumed=false,consumerClean=false,bindingCleanupFailed=false,closing:Promise<void>|undefined
   const callerGuard=originalTaskCallerGuard(caller)??unassociated
   const current=()=>runOriginalCurrentnessRead(callerGuard,()=>{if(retired)throw retired.cause;if(!published)checkCaller(caller);callOriginalCurrentnessMethod(callerGuard,hooks,'current',[task])})
   const retire=(cause:unknown)=>{if(!retired){retired={cause};removeAbort();if(!published){if(!started)completion.reject(cause);void Promise.resolve().then(close).catch(()=>{})}}}
   const close=()=>{if(closing)return closing;const flight=(async()=>{
    const errors:unknown[]=[]
    try{if(!consumed&&!consumerClean){const outcome=binding?.outcome();if(bindingCleanupFailed&&outcome?.kind==='committed'&&!outcome.cleanupPending)await binding?.retry();else await binding?.retireConsumer();consumerClean=true}}catch(error){bindingCleanupFailed=true;errors.push(error)}
    for(const item of recovery)if(!item.closed)try{await item.close();item.closed=true}catch(error){errors.push(error)}
    await preparation?.catch(()=>{})
    for(const item of [...setup].reverse())if(!item.closed)try{await item.close();item.closed=true}catch(error){errors.push(error)}
    if(errors.length)throw new AggregateError(errors,'Original task slot cleanup unresolved');removeAbort()
   })();closing=flight;void flight.finally(()=>{if(closing===flight)closing=undefined}).catch(()=>{});return flight}
   const slot:TaskLaunchSlot={get task(){return task},caller,...history?{history}:{},role:roleIntent,flight:completion.promise,get accepted(){return accepted},
    acknowledgeDelivery(value){if(this!==slot||deliveryPreparation)throw Error('Original delivery already acknowledged');current();deliveryPreparation=value},
    acknowledgeStart(receipt){if(this!==slot||startReceipt)throw Error('Original start already acknowledged');current();inspectOriginalSpawnStart(receipt,'kind'in caller.context?caller.context.domain.owner:caller.context.factOwner);startReceipt=receipt},
    assertSourceCut(){if(this!==slot||!history||!startReceipt)throw Error('Original task start unavailable');current();if(managedHistory){if(!('kind'in caller.context)||caller.identity.callEventSeq===undefined)throw Error('Original managed Task caller unavailable');const domain=caller.context.domain,start=inspectManagedSpawnStart(startReceipt,domain),open=deliveryPreparation?inspectManagedTaskDeliveryOpen(deliveryPreparation,domain):undefined;managedHistory.reservation.assertSourceCut({parentSessionId:caller.identity.parentSessionId,taskId:task.id,agentPath:task.agentPath,role:roleIntent.name,sourceNamespace:context.sessionId!,callSeq:caller.identity.callEventSeq,...open?{open}:{},start});return}const captured=inspectTaskChildSource(history,caller.identity.parentSessionId),start=inspectOriginalSpawnStart(startReceipt,captured.owner),open=deliveryPreparation?inspectOriginalTaskDeliveryOpen(deliveryPreparation,captured.owner):undefined,event=captured.view.events[start.seqs[0]!];if(open&&(open.view!==captured.view||open.seq!==captured.count||captured.view.events[open.seq]!==open.event||canonicalJsonData(open.event)!==open.eventData||open.binding.recipientSessionId!==caller.identity.parentSessionId||open.binding.sourceId!==task.id||open.binding.callSeq!==caller.identity.callEventSeq||canonicalJsonData(deliveryPreparation)!==canonicalJsonData({kind:'bound',binding:open.binding})))throw Error('Original delivery preparation changed');const offset=open?1:0;if(!start.seqs.length||captured.view.events.length!==captured.count+offset+start.seqs.length||start.seqs.some((seq,index)=>seq!==captured.count+offset+index||captured.view.events[seq]!==start.events[index])||!event||canonicalJsonData(event)!==canonicalJsonData({...start.event,seq:start.seqs[0]})||event.type!=='subagent/start'||event.taskId!==task.id||event.agentPath!==task.agentPath||event.role!==roleIntent.name||event.parentSessionId!==caller.identity.parentSessionId)throw Error('Original task history suffix changed')},
    captureSelection<T>(read:()=>T):T {if(this!==slot)throw TypeError('Foreign slot');current();if(!selection){try{const value=read();selection={value:value===undefined?undefined:freeze(captureTaskSnapshot(value))};current()}catch(cause){selection={cause};throw cause}}if('cause'in selection)throw selection.cause;return selection.value as T},
    keep(cleanup){if(this!==slot)throw TypeError('Foreign slot');const close=cleanup.close.bind(cleanup);setup.push({close,closed:false});try{current()}catch(cause){retire(cause);throw cause}},
    keepRecovery(cleanup){if(this!==slot)throw TypeError('Foreign slot');recovery.push({close:cleanup.close.bind(cleanup),closed:false});current()},
    beforeResultIssue(before){if(this!==slot)throw TypeError('Foreign slot');current();hooks.beforeResultIssue(task,before)},
    retainResult(){if(this!==slot)return Promise.reject(TypeError('Foreign slot'));return hooks.retainResult(task)},
    assertCurrent(){if(this!==slot)throw TypeError('Foreign slot');current()},
    published(){if(this!==slot)throw TypeError('Foreign slot');current();published=true;removeAbort()},
    retainPublication(phase){if(this!==slot)throw TypeError('Foreign slot');current();if(publication.has(phase.kind))throw Error('Original publication already captured');publication.set(phase.kind,phase.value)},
    start(make){if(this!==slot)throw TypeError('Foreign slot');if(started)return;started=true;preparation=(async()=>{await accepted;current();const result=await make();completion.resolve(result)})();void preparation.catch(async cause=>{retire(cause);try{await close()}catch{/* Retained for explicit original close. */}completion.reject(cause)})},
    bind(birth){if(this!==slot)return Promise.reject(TypeError('Foreign slot'));try{current();if(binding)throw Error('Original task binding already captured');bindingIntent=freeze(captureTaskSnapshot(birth) as TaskChildBirthBinding);binding=hooks.bind(task,bindingIntent);return binding.done.catch(cause=>{retire(cause);throw cause})}catch(cause){retire(cause);return Promise.reject(cause)}},
    assertBinding(){if(this!==slot)throw TypeError('Foreign slot');current();if(!binding||consumed)throw Error('Original binding unavailable');binding.assertHandoff()},
    async retryBinding(){if(this!==slot)throw TypeError('Foreign slot');if(!binding)throw Error('Original binding unavailable');if(retired){await binding.retireConsumer().catch(()=>{});await binding.retry();consumerClean=true}else await binding.retry()},
    consumeBinding(){if(this!==slot)throw TypeError('Foreign slot');slot.assertBinding();binding!.release();consumed=true},
    retire(cause){if(this!==slot)throw TypeError('Foreign slot');retire(cause)},
   };Object.freeze(slot);propagateOriginalCurrentnessReader(hooks,'current',slot,'assertCurrent',[callerGuard]);issued.add(slot)
   let result:ReturnType<typeof hooks.insert>
   try{caller.consume();result=hooks.insert(intent);task=result.record}catch(cause){if(managedHistory){orphanHistories.add(managedHistory.reservation);void managedHistory.reservation.close().catch(()=>{})}throw cause}
   if(!result.inserted){if(managedHistory){orphanHistories.add(managedHistory.reservation);void managedHistory.reservation.close().catch(()=>{})}const old=slots.get(task);if(!old)throw Object.assign(Error('Existing cold task has no original warm slot'),{code:'TASK_COLD_BINDING_UNAVAILABLE'});if(old.caller.identity.parentSessionId!==caller.identity.parentSessionId||old.caller.identity.callEventSeq!==caller.identity.callEventSeq||old.caller.identity.toolCallId!==caller.identity.toolCallId)throw Error('Original caller identity conflict');return {kind:'same',slot:old}}
   slots.set(task,slot);states.set(slot,{retire,close,snapshot(){const field=Object.getOwnPropertyDescriptor(task,'childBirth');if(field&&(!bindingIntent||!('value'in field)||field.value!==bindingIntent||!field.enumerable||field.configurable||field.writable))throw Error('Foreign prebinding task birth')}})
   const signal=caller.exec.abortSignal
   if(signal){const abort=()=>retire(signal.reason);removeAbort=()=>EventTarget.prototype.removeEventListener.call(signal,'abort',abort);EventTarget.prototype.addEventListener.call(signal,'abort',abort,{once:true});if(signal.aborted)abort()}
   hooks.protect(task)
   try{accepted=hooks.accept(task);void accepted.catch(retire)}catch(cause){accepted=Promise.reject(cause);void accepted.catch(()=>{});retire(cause)}
   return {kind:'new',slot}
  },
  retireTask(id,cause){for(const [task,slot]of slots)if(task.id===id)states.get(slot)!.retire(cause)},
  retireAll(cause){stopped??={cause};for(const state of states.values())state.retire(cause)},
  async close(){const results=await Promise.allSettled([...states.values()].map(state=>state.close()).concat([...orphanHistories].map(async history=>{await history.close();orphanHistories.delete(history)})));const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Original task slots require cleanup')},
  assertSnapshot(){for(const state of states.values())state.snapshot()},
 };Object.freeze(port);ports.set(registry,port);return port
}
