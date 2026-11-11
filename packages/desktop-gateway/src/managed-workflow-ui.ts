import type {ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {SessionEvent} from '@i-harness/core-session'
import {foldJobs,projectJobsDoc} from '@i-harness/jobs'
import type {SessionCoordinator} from '@i-harness/session-persistence'
import type {SessionService} from '@i-harness/session-executor'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {createManagedGoalUi} from './managed-goal-ui.ts'
import type {ManagedWorkflowUi} from './workflow.ts'

/** Only the published runtime and its original currentness can back this UI. */
export function createManagedWorkflowUi(input:{id:string;execution:ManagedExecutionAttachment;domain:ManagedExecutionDomain;assertCurrent():void;retain(close:()=>Promise<void>):void;coordinator:SessionCoordinator;service:SessionService;jobEvents(documentJobIds:readonly string[]):Promise<readonly SessionEvent[]>;lastStepSince(ordinal:number):Promise<{refused?:boolean;empty?:boolean}|undefined>}):ManagedWorkflowUi{
 const {id,execution,domain}=input
 if(domain.identity!==execution.identity||domain.owner!==execution.owner||domain.sessionId!==id)throw TypeError('Original managed workflow runtime required')
 input.assertCurrent()
 const goal=createManagedGoalUi(execution,domain,()=>input.assertCurrent(),input.retain)
 return Object.freeze({goal,assertCurrent:()=>input.assertCurrent(),lastStepSince:input.lastStepSince,
  async details(){input.assertCurrent();const observed=execution.observe(),doc=await input.coordinator.getDocument(id),documentJobs=projectJobsDoc(doc),events=await input.jobEvents(documentJobs.map(job=>job.jobId));input.assertCurrent();observed.assertCurrent();const jobs=new Map([...documentJobs,...foldJobs(events)].map(job=>[job.jobId,job])),live=input.service.tasks(id);return {jobs:[...jobs.values()].slice(-200).map(job=>{const task=live.find(row=>row.id===job.jobId);return {...job,live:!!task,canCancel:task?.canCancel===true}})}},
 })
}
