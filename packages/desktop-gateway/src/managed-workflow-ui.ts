import {randomUUID} from 'node:crypto'
import {captureManagedTeamParent,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {SessionEvent} from '@i-harness/core-session'
import {foldTeam} from '@i-harness/agent-team'
import {foldJobs,projectJobsDoc} from '@i-harness/jobs'
import {validateJsonSchemaValue,type JsonSchemaNode,type ToolRegistry} from '@i-harness/core-tools'
import type {SessionCoordinator} from '@i-harness/session-persistence'
import type {SessionService} from '@i-harness/session-executor'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {createManagedGoalUi} from './managed-goal-ui.ts'
import type {ManagedWorkflowUi} from './workflow.ts'
const allowedTeamTools=new Set(['spawn_teammate','send_message','followup_task','interrupt_agent','team_task_create','team_task_update'])

/** Only the published runtime and its original currentness can back this UI. */
export function createManagedWorkflowUi(input:{id:string;execution:ManagedExecutionAttachment;domain:ManagedExecutionDomain;tools:ToolRegistry;assertCurrent():void;retain(close:()=>Promise<void>):void;coordinator:SessionCoordinator;service:SessionService;teamEnabled:boolean;jobEvents():Promise<readonly SessionEvent[]>;lastStepSince(ordinal:number):Promise<{refused?:boolean;empty?:boolean}|undefined>}):ManagedWorkflowUi{
 const {id,execution,domain}=input
 if(domain.identity!==execution.identity||domain.owner!==execution.owner||domain.sessionId!==id)throw TypeError('Original managed workflow runtime required')
 input.assertCurrent();const teamParents=new Set<ReturnType<typeof captureManagedTeamParent>>()
 input.retain(async()=>{for(const parent of [...teamParents]){await parent.close();teamParents.delete(parent)}})
 const goal=createManagedGoalUi(execution,()=>input.assertCurrent(),input.retain)
 return Object.freeze({goal,assertCurrent:()=>input.assertCurrent(),lastStepSince:input.lastStepSince,
  async details(){input.assertCurrent();const observed=execution.observe(),parent=captureManagedTeamParent(domain);teamParents.add(parent);try{await parent.ready;parent.assertCurrent();const team=foldTeam(parent.ledger).state,events=await input.jobEvents(),doc=await input.coordinator.getDocument(id);input.assertCurrent();observed.assertCurrent();parent.assertCurrent();const jobs=new Map([...projectJobsDoc(doc),...foldJobs(events)].map(job=>[job.jobId,job])),live=input.service.tasks(id);return {jobs:[...jobs.values()].slice(-200).map(job=>{const task=live.find(row=>row.id===job.jobId);return {...job,live:!!task,canCancel:task?.canCancel===true}}),team:{enabled:input.teamEnabled,members:[...team.members.values()],tasks:[...team.tasks.values()].filter(task=>task.status!=='deleted')}}}finally{await parent.close();teamParents.delete(parent)}},
  async teamCommand(name:string,args:Record<string,unknown>){input.assertCurrent();if(!input.teamEnabled||!allowedTeamTools.has(name))throw Error('Team action unavailable');const tool=input.tools.get(`team_${name}`)??input.tools.get(name);if(!tool)throw Error('Team tool unavailable');const invalid=validateJsonSchemaValue(tool.inputSchema as JsonSchemaNode,args);if(invalid.length)throw Error(`Invalid team arguments: ${invalid[0]}`);const execute=tool.execute;await Reflect.apply(execute,tool,[args,{sessionId:id,callId:`desktop-${randomUUID()}`}]);input.assertCurrent()},
 })
}
