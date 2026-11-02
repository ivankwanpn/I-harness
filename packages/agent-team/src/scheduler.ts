import {captureOriginalTeamColdBinding,captureOriginalTeamColdTarget} from '../../session-persistence/src/team-child-recovery-internal.ts'
import {bindPreparedTeamLaunchLeaf,type OriginalManagedTeamCaller} from '@i-harness/core-tools/internal/team-caller'
// M19 Task 10: mount/unmount lifecycle for the Team scope — the REAL subagent
// wiring (Rulings 4 / 17-21). The plan's sketch is a skeleton; here every
// bridge the domain layer needs (roster/mailbox) is bound to the live subagent
// machinery: spawnChild with durable child-<uuid> sessions, durability probes
// via coordinator.snapshot, interrupt/close via the agent table, and message
// delivery through the child's durable session mirror.

import { type FactOwner, type SessionView as Session } from "@i-harness/core-session"
import { createTeamFacts, teamFactOwner, managedTeamFactOwner } from './facts.ts'
import {assertOriginalManagedTeamParent,createOriginalTeamProvisioningOwner,reserveOriginalTeamRecoveryParent,assertOriginalTeamRecoveryParent,isManagedExecutionDomain,type OriginalManagedTeamParent,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type { PluginContext } from "@i-harness/core-plugin"

import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { ExecService } from "@i-harness/exec"
import type { ToolRegistry, ToolExec } from "@i-harness/core-tools"
import type { AgentTable, ChildAgentEntry, JobRegistry, ParentInputAdmission, RoleRegistry, RoleCleanup, SpawnOptions, SubagentRole } from "@i-harness/subagent"
import type { TeamConfig } from "./types.ts"
import { admitTeam, admitTeamFromLedger, releaseTeam, resolveTeamCaller } from "./scheduler/admission.ts"
import { TEAMMATE_BASE_TOOLS, TEAMMATE_ROLE_NAME, teammateRole, createTeammateSpawner, createTeammateControls, createMemberStatus } from "./scheduler/teammate-lifecycle.ts"
import { createCompletionJobs } from "./scheduler/completion.ts"
import { createTaskDelivery } from "./scheduler/task-delivery.ts"
import { createDurabilityProbes, mountTeamTools } from "./scheduler/recovery.ts"

import { createTeamTransact } from "./transact.ts"
import { createRoster } from "./roster.ts"
import { createMailbox } from "./mailbox.ts"
import { createTaskBoard } from "./task-board.ts"
import { createActivity } from "./activity.ts"
import { createTeamTools } from "./tools.ts"
import { AgentPath } from "./agent-path.ts"

export interface TeamSubagentDeps {
  reserveManagedColdTeamChild?: import('@i-harness/subagent').RegisterSubagentResult['reserveManagedColdTeamChild']
  reserveManagedTeamChild?: (caller:OriginalManagedTeamCaller,provisioning:import('../../core-session/src/managed/team-provisioning.ts').OriginalTeamProvisioning)=>import('@i-harness/subagent').TeamChildBirthAttempt
  createInstructionContext?: SpawnOptions['createInstructionContext']
  retainInitialSetup?: SpawnOptions['retainInitialSetup']
  generationFactoryFor?: SpawnOptions['generationFactoryFor']
  modelActionTimeoutMs?: number
  modelActionMaxAttempts?: number
  reportPolicy?: import("@i-harness/subagent").ReportPolicy
  retainResults?: () => Promise<"durable" | "memory">
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  // M19 Ruling 17: live Agent instances registry (created by registerSubagent)
  // — the wakeup bridge needs the resident Agent instance for followup
  // re-drives.
  agents: AgentRegistry
  exec: ExecService
  /** Forwarded verbatim to `spawnChild` — see SpawnOptions.resolveModel. */
  resolveModel: SpawnOptions["resolveModel"]
  /** Forwarded verbatim to `spawnChild` too — the host's declared role models
   * and the `plugins.subagentModel` switch. WITHOUT them a spawned teammate
   * silently inherits the parent's client: the declared selection collapses to
   * the role's own `model` (undefined for a settings-declared entry), so the
   * gate never fires and no message is produced — while the SAME teammate's
   * wakeup rebuild (ensureResident, wired with the full deps) resolves the
   * declared one. One teammate, two models, no surface saying so. */
  roleSelectionFor?: SpawnOptions["roleSelectionFor"]
  allowSubagentModelSelection?: SpawnOptions["allowSubagentModelSelection"]
  autoCompactionEnabled?: SpawnOptions["autoCompactionEnabled"]
  inheritedSystemContext?: SpawnOptions["inheritedSystemContext"]
  codeMode?: SpawnOptions["codeMode"]
  codeModeFactory?: SpawnOptions["codeModeFactory"]
  /** M73: the session's own model's numbers, mirrored from SpawnOptions the way
   * the two fields above are. A teammate with no declared model runs on the
   * session's model, so its requests are clamped and measured against the same
   * window and cap — the roster's spawn and the spawn_agent tool must not
   * disagree about what the same session's budget is. Absent → no key written. */
  contextWindow?: SpawnOptions["contextWindow"]
  budgetBinding?: SpawnOptions["budgetBinding"]
  contextMetadata?: SpawnOptions["contextMetadata"]
  reasoningEffort?: SpawnOptions["reasoningEffort"]
  inheritedBindingForStep?: SpawnOptions["inheritedBindingForStep"]
  results?: SpawnOptions['results']
  summaryFactory?: SpawnOptions['summaryFactory']
  maxOutputTokens?: SpawnOptions["maxOutputTokens"]
  // M8 durable child sessions: coordinator + parent session id. When present,
  // spawned teammates get durable child-<uuid> sessions (lineage header) and
  // their inbox appends go through the write-behind mirror. WITHOUT it the
  // roster's durability gate fails closed (no sessionId → no durable proof).
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  // M23 (Minor 4): lazy resident rebuild injection — wired by run.ts from
  // registerSubagent's ensureResident closure (TeamSubagentDeps has NO
  // parentCtx/parentRegistry/parentModel, so the scheduler cannot rebuild a
  // teammate itself). When present, realDeliver may rebuild a post-resume
  // teammate (restoreState maps running/waiting → "error" and the Agent
  // registry is fresh-empty) instead of dropping the drive; absent keeps the
  // conservative behavior (message stays queued).
  ensureResident?: (entry: ChildAgentEntry, controller?: AbortController, executionCurrent?: () => boolean) => Promise<boolean>
  followupActivation?: import('@i-harness/subagent').FollowupDeps['activation']
  captureFollowupGeneration?: import('@i-harness/subagent').FollowupDeps['captureGeneration']
  followupGeneration?: import('@i-harness/subagent').FollowupDeps['openGeneration']
}

export interface TeamDeps {
  /** Receives the original partial shell before any owned mutation. */
  retainMount?: (handle: TeamMountHandle) => void
  parentNotify?: ParentInputAdmission
  /** Desktop sessions own independent team tool registries and ledgers. */
  allowConcurrentTeams?: boolean
  preserveSubagentTools?: boolean
  // lead session (the team's parent/main session; its event log is the team
  // log — every team/* event is appended here)
  parentSession?: Session
  managedParent?: {domain:ManagedExecutionDomain; parent:OriginalManagedTeamParent}
  factOwner?: FactOwner
  parentRegistry: ToolRegistry
  subagents: TeamSubagentDeps
  parentModel: ModelClient
  // Test-only override seams (Ruling 20): the scheduler uses the REAL subagent
  // binding when an override is absent. They keep the lifecycle test real
  // without spawning processes.
  spawnChild?: (name: string, prompt: string, context: "fresh" | "fork", opts?: { forkTurns?: "none" | "all" | number; managed?:{caller:OriginalManagedTeamCaller;provisioning:import('../../core-session/src/managed/team-provisioning.ts').OriginalTeamProvisioning} }) => Promise<{ path: string; jobId: string; sessionId?: string }>
  childSessionHoldsPrompt?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  childSessionIsDurable?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  interruptChild?: (path: string) => Promise<string>
  closeChild?: (path: string) => Promise<void>
  deliver?: (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", signal?: AbortSignal) => Promise<boolean>
  memberStatus?: (id: string) => string
}

export interface TeamMountHandle {
  teamName: string
  unmount(): Promise<void>
  drainLeadMessages?(): Promise<void>
  resumeRecovery?(): Promise<void>
}

const originalTeamMounts=new WeakMap<TeamMountHandle,ManagedExecutionDomain>()
const issuedRecoveryPorts=new WeakSet<TeamMountHandle>()
const originalTeamRecoveryPorts=new WeakMap<object,{domain:ManagedExecutionDomain;handle:TeamMountHandle}>()
export function isOriginalTeamRecoveryPort(value:object,domain:ManagedExecutionDomain,handle:TeamMountHandle):boolean{const original=originalTeamRecoveryPorts.get(value);return !!original&&original.domain===domain&&original.handle===handle}
/** The mount itself issues this port through its synchronous retainMount callback. */
export function createOriginalTeamRecoveryPort(domain:ManagedExecutionDomain,handle:TeamMountHandle){
 if(originalTeamMounts.get(handle)!==domain||issuedRecoveryPorts.has(handle))throw TypeError('Original Team mount required')
 domain.assertCurrent()
 const resume=Object.getOwnPropertyDescriptor(handle,'resumeRecovery'),close=Object.getOwnPropertyDescriptor(handle,'unmount')
 if(!resume||!('value' in resume)||typeof resume.value!=='function'||!close||!('value' in close)||typeof close.value!=='function')throw TypeError('Original Team mount methods required')
 const current=()=>{for(const [key,field] of [['resumeRecovery',resume],['unmount',close]] as const){const now=Object.getOwnPropertyDescriptor(handle,key);if(!now||!('value' in now)||now.value!==field.value||now.enumerable!==field.enumerable||now.configurable!==field.configurable||now.writable!==field.writable)throw TypeError('Original Team mount changed')}}
 let closed=false,closing:Promise<void>|undefined
 const port=Object.freeze({async resume(){if(this!==port||closed||closing)throw TypeError('Original Team recovery port unavailable');domain.assertCurrent();current();await Reflect.apply(resume.value,handle,[]);domain.assertCurrent();current()},close(){if(this!==port)return Promise.reject(TypeError('Original Team recovery port required'));if(closed)return Promise.resolve();if(closing)return closing;let flight:Promise<void>;try{flight=Promise.resolve(Reflect.apply(close.value,handle,[])).then(()=>{closed=true})}catch(error){return Promise.reject(error)}closing=flight;void flight.finally(()=>{if(closing===flight)closing=undefined}).catch(()=>{});return flight}})
 issuedRecoveryPorts.add(handle);originalTeamRecoveryPorts.set(port,{domain,handle});return port
}

export class TeamMountRecoveryRequired extends Error {
  constructor(cause:unknown,readonly handle:TeamMountHandle){super('Team recovery remains incomplete',{cause});this.name='TeamMountRecoveryRequired'}
}

export class TeamMountFailure extends AggregateError {
  constructor(cause: unknown, cleanupError: unknown, readonly cleanup: TeamMountHandle) {
    super([cause, cleanupError], 'Team construction and cleanup failed', { cause })
    this.name = 'TeamMountFailure'
  }
}

export async function mountAgentTeams(
  ctx: PluginContext,
  tools: ToolRegistry,
  deps: TeamDeps,
  config?: Partial<TeamConfig>,
): Promise<TeamMountHandle> {
  // config validation BEFORE anything is reserved (fail-closed, no side effects)
  if(!!deps.parentSession===!!deps.managedParent)throw TypeError('Exactly one original Team parent required')
  if(deps.managedParent&&deps.spawnChild)throw TypeError('Original managed Team child owner required')
  const managed=deps.managedParent
  if(managed){if(!isManagedExecutionDomain(managed.domain,ctx))throw TypeError('Original Team context required');assertOriginalManagedTeamParent(managed.domain,managed.parent);managed.parent.assertCurrent()}
  const { cfg, state, teamId } = managed ? admitTeamFromLedger(deps.allowConcurrentTeams,managed.parent.ledger as Parameters<typeof admitTeamFromLedger>[1],config) : admitTeam({allowConcurrentTeams:deps.allowConcurrentTeams,parentSession:deps.parentSession!}, config)
  let phase: 'constructing' | 'partial' | 'open' | 'retiring' | 'recovery' | 'closed' = 'constructing'
  const isRetired = () => phase !== 'constructing' && phase !== 'partial' && phase !== 'open'
  const assertConstructing = () => { if (isRetired()) throw Object.assign(new Error('Team construction is closed'), { code: 'FACT_CLOSED' }) }
  const initialPending=new Set([...state.members.values()].filter(member=>member.phase==='provisioning').map(member=>member.name))
  let resumeRecovery:(()=>Promise<void>)|undefined,recoveryFlight:Promise<void>|undefined
  const driveRecovery=()=>{if(recoveryFlight)return recoveryFlight;const flight=resumeRecovery!();recoveryFlight=flight;void flight.finally(()=>{if(recoveryFlight===flight)recoveryFlight=undefined}).catch(()=>{});return flight}
  let inFlight: Promise<void> | undefined
  let activity: ReturnType<typeof createActivity> | undefined
  let lead: ReturnType<typeof createTeamFacts> | undefined
  let factsCleanup: (() => Promise<void>) | undefined
  let factsClosed = false, toolsClosed = false, roleClosed = false, parentClosed = !managed
  const teamBirths=new Set<import('@i-harness/subagent').TeamChildBirthAttempt>()
  const coldResources=new Set<{close():Promise<void>}>()
  let toolMount: ReturnType<typeof mountTeamTools> | undefined
  let completions: ReturnType<typeof createCompletionJobs> | undefined
  let mailbox: ReturnType<typeof createMailbox> | undefined
  let children: { path: string; entry: ChildAgentEntry; agent: ReturnType<AgentRegistry['get']>; disposed: boolean; jobClosed: boolean; detached: boolean; removeAgent: boolean }[] | undefined
  let generatedRole: SubagentRole | undefined
  let generatedRoleCleanup: RoleCleanup | undefined
  const removeGeneratedRole = async () => {
    if (!generatedRole) return
    if (generatedRoleCleanup) await generatedRoleCleanup()
    else if (deps.subagents.roles.get(TEAMMATE_ROLE_NAME) !== undefined) throw new Error('Original Team role registration cleanup unavailable')
  }
  const handle: TeamMountHandle = {
    teamName: teamId,
    unmount() {
      if (inFlight) return inFlight
      if (phase === 'closed') return Promise.resolve()
      phase = 'retiring'
      // Fence admission and release every waiter synchronously, before joins.
      lead?.retire(); completions?.sealCompletions(); activity?.close()
      const attempt = (async () => {
        const failures: unknown[] = []
        await lead?.joinRuns()
        await recoveryFlight?.catch(()=>{})
        try { await completions?.joinCompletions() }
        catch (error) { failures.push(...(error instanceof AggregateError ? error.errors : [error])) }
        for(const resource of coldResources)try{await resource.close();coldResources.delete(resource)}catch(error){failures.push(error)}
        for(const birth of teamBirths)try{await birth.close();teamBirths.delete(birth)}catch(error){failures.push(error)}
        try { if (!factsClosed && teamBirths.size===0 && coldResources.size===0) { await factsCleanup?.(); factsClosed = true } } catch (error) { failures.push(error) }
        // Sealed accepted acquisitions have now finished publication or failed.
        // Freeze membership once, retaining exact entries and phase bits on retry.
        children ??= [...deps.subagents.table.entries()].filter(([path]) => path.startsWith('lead/')).map(([path, entry]) => ({
          path, entry, agent: entry.sessionId ? deps.subagents.agents.get(entry.sessionId) : undefined,
          disposed: false, jobClosed: false, detached: false, removeAgent: false,
        }))
        for (const child of [...children!]) {
          const { path, entry } = child, sub = deps.subagents
          try {
            if (!child.disposed) {
              sub.table.update(path, entry, { closing: true })
              entry.controller.abort()
              if (entry.dispose) await entry.dispose()
              else { await entry.followupChain?.catch(() => {}); entry.unmount?.() }
              child.disposed = true
            }
            if (!child.jobClosed) { if (entry.jobId) sub.jobs.kill(entry.jobId); child.jobClosed = true }
            if (!child.detached) {
              const ownsEntry = sub.table.get(path) === entry
              if (ownsEntry) sub.table.remove(path)
              child.removeAgent = ownsEntry
              child.detached = true
            }
            if (child.removeAgent && entry.sessionId && sub.agents.get(entry.sessionId) === child.agent) sub.agents.remove(entry.sessionId)
            children!.splice(children!.indexOf(child), 1)
          } catch (error) { failures.push(error) }
        }
        try { if (!toolsClosed) { await toolMount?.close(); toolsClosed = true } } catch (error) { failures.push(error) }
        try { if (!roleClosed) { await removeGeneratedRole(); roleClosed = true } } catch (error) { failures.push(error) }
        try { if (!parentClosed && coldResources.size===0) { await managed!.parent.close(); parentClosed=true } } catch(error) { failures.push(error) }
        if (factsClosed && children!.length === 0 && toolsClosed && roleClosed && parentClosed) { releaseTeam(teamId); phase = 'closed' }
        else phase = 'recovery'
        if (failures.length) throw Object.assign(new AggregateError(failures, 'Team cleanup incomplete'), { resourcesClosed: phase === 'closed' })
      })()
      inFlight = attempt
      const clear = () => { if (inFlight === attempt) inFlight = undefined }
      void attempt.then(clear, clear)
      return attempt
    },
    async resumeRecovery(){if(this!==handle||phase!=='partial'||!resumeRecovery)throw Error('Team recovery unavailable');await driveRecovery()},
    async drainLeadMessages() { if (phase === 'open') await lead!.withoutRun(() => mailbox!.recoverRoot(teamId)) },
  }
  // Every failure path invokes this same shell; only acknowledged resource
  // cleanup releases its reservation.
  try {
    if(managed)originalTeamMounts.set(handle,managed.domain)
    deps.retainMount?.(handle)
    assertConstructing()
    const sub = deps.subagents
    completions = createCompletionJobs(sub, state, cfg, isRetired, () => mailbox!, () => activity!, work => lead!.withoutRun(work))
    const { teamJobs } = completions
    let teamToolNames: string[] = []
    // Teammate role tool surface (Minor 5): derived from the CREATED team tools
    // (Ruling 19 discipline) minus the Lead-only ones; populated right after
    // createTeamTools below — spawns only ever happen post-mount, so the
    // closure reads the final value.
    let teamRoleTools: string[] = [...TEAMMATE_BASE_TOOLS, ...(tools.get("shell") ? ["shell"] : [])]
    activity = createActivity({ waitMinMs: cfg.waitMinMs, waitMaxMs: cfg.waitMaxMs, waitDefaultMs: cfg.waitDefaultMs })
    const provisioningOwner=managed?createOriginalTeamProvisioningOwner(managed.domain,managed.parent):undefined
    const originalOwner=managed ? managedTeamFactOwner(managed.domain,()=>{assertOriginalManagedTeamParent(managed.domain,managed.parent);managed.parent.assertCurrent()}) : teamFactOwner(deps.parentSession!,deps.factOwner)
    lead = createTeamFacts(originalOwner,()=>tx.drain(),()=>activity!.notify(), close => { factsCleanup = close }, provisioningOwner)
    const tx = createTeamTransact(lead, state)

    // ---- real bridge bindings (Ruling 18) ----

    const realSpawnChild = createTeammateSpawner(ctx, deps, sub, teamJobs, () => teamRoleTools, activity, birth=>teamBirths.add(birth), birth=>teamBirths.delete(birth), async witness=>{if(!tx.releaseProvisioning)throw TypeError('Original Team provisioning cleanup unavailable');await tx.releaseProvisioning(witness)})
    const spawnChildFn = deps.spawnChild ?? realSpawnChild

    const { realHoldsPrompt, realIsDurable } = createDurabilityProbes(sub)
    const holdsPrompt = deps.childSessionHoldsPrompt ?? realHoldsPrompt
    const isDurable = deps.childSessionIsDurable ?? realIsDurable

    const { realInterruptChild, realCloseChild } = createTeammateControls(sub, activity)
    const interruptChild = deps.interruptChild ?? realInterruptChild
    const closeChild = deps.closeChild ?? realCloseChild

    const realMemberStatus = createMemberStatus(teamId, state, sub)
    const memberStatus = deps.memberStatus ?? realMemberStatus

    const realDeliver = createTaskDelivery(teamId, state, deps, sub, teamJobs, activity, isRetired, originalOwner)
    // Boolean overrides confer only their returned disposition; rejection keeps
    // its original value and grants no Team acknowledgement authority.
    const booleanDeliver = deps.deliver
    const deliver: typeof realDeliver = booleanDeliver
      ? async (...args) => await booleanDeliver(...args)
        ? { kind: 'consumed', via: 'target', sendFailure: { occurred: false } }
        : { kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } }
      : realDeliver

    const coldIssuerField=Object.getOwnPropertyDescriptor(sub,'reserveManagedColdTeamChild')
    const coldIssuer=coldIssuerField&&'value' in coldIssuerField?coldIssuerField.value:undefined
    const assertColdIssuer=()=>{const field=Object.getOwnPropertyDescriptor(sub,'reserveManagedColdTeamChild');if(typeof coldIssuer!=='function'||!field||!('value' in field)||field.value!==coldIssuer||field.enumerable!==coldIssuerField!.enumerable||field.configurable!==coldIssuerField!.configurable||field.writable!==coldIssuerField!.writable)throw TypeError('Original Team cold issuer changed')}

    // ---- build the domain ----
    const roster = createRoster({
      teamId,
      ...managed?{managedDomain:managed.domain}:{},
      state,
      transact: tx,
      spawnChild: spawnChildFn,
      ...(managed?{recoverManaged:async (member:import('./types.ts').TeamMemberSnapshot)=>{
        const coordinator=sub.childSessions?.coordinator
        if(!coordinator||typeof coldIssuer!=='function'||member.context!=='fresh')throw Object.assign(Error('Original Team birth recovery required'),{code:'FACT_RECOVERY_REQUIRED'})
        const owner=provisioningOwner!,parent=reserveOriginalTeamRecoveryParent(owner)
        let binding:ReturnType<typeof captureOriginalTeamColdBinding>|undefined,target:ReturnType<typeof captureOriginalTeamColdTarget>|undefined,attempt:import('@i-harness/subagent').TeamChildBirthAttempt|undefined
        const resource={async close(){if(attempt){await attempt.close();attempt=undefined}if(target){await target.close();target=undefined}if(binding){await binding.close();binding=undefined}await parent.close()}}
        coldResources.add(resource)
        try{await parent.ready;assertOriginalTeamRecoveryParent(owner,parent);void parent.ledger
        binding=captureOriginalTeamColdBinding(coordinator,{domain:managed.domain,owner,parent,teamId,memberId:member.id});await binding.ready;const inspected=binding.inspect()
        if(inspected.kind!=='confirmed'||inspected.binding.request.core.history.selection.kind!=='none')throw Object.assign(Error('Original Team birth recovery required'),{code:'FACT_RECOVERY_REQUIRED'})
        target=captureOriginalTeamColdTarget(coordinator,binding);await target.ready
        if(target.result.kind!=='materialized')throw Object.assign(Error('Original Team birth recovery required'),{code:'FACT_RECOVERY_REQUIRED'})
        assertColdIssuer();attempt=Reflect.apply(coldIssuer!,sub,[owner,parent,binding,target]);const birth=await attempt!.run();assertColdIssuer()
        const out=await realSpawnChild(member.name,inspected.binding.initial.text,'fresh',{coldBirth:birth})
        if(out.sessionId!==member.id)throw TypeError('Original Team target changed')
        await resource.close();coldResources.delete(resource)
        }catch(primary){try{await resource.close();coldResources.delete(resource)}catch(cleanup){throw new AggregateError([primary,cleanup],'Team recovery and cleanup failed')}throw primary}
      }}:{}),
      childSessionHoldsPrompt: holdsPrompt,
      childSessionIsDurable: isDurable,
      interruptChild,
      closeChild,
      maxMembers: cfg.maxMembers,
      startupTimeoutMs: cfg.startupTimeoutMs,
      memberStatus,
      memberJobId: id => {
        const member = [...state.members.values()].find(row => row.id === id)
        return member ? sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())?.jobId : undefined
      },
    })
    mailbox = createMailbox({
      teamId,
      state,
      transact: tx,
      deliver,
      memberStatus: (id) => memberStatus(id) as "running" | "idle" | "inactive" | "provisioning" | "failed",
      maxPendingMessagesPerMember: cfg.maxPendingMessagesPerMember,
      maxMessageBytes: cfg.maxMessageBytes,
    })
    const taskBoard = createTaskBoard({ teamId, state, transact: tx, maxTasks: cfg.maxTasks })

    let teamEntry:ReturnType<typeof bindPreparedTeamLaunchLeaf>|undefined,launchTool:import('@i-harness/core-tools').Tool|undefined
    const toolDeps = {
      ...(managed?{captureTeamCaller(exec:ToolExec){if(!teamEntry||!launchTool||tools.get('spawn_teammate')!==launchTool)throw TypeError('Original Team leaf unavailable');const caller=teamEntry.enter(exec);if(!caller||caller.context.domain!==managed.domain||caller.context.context!==ctx||caller.identity.parentSessionId!==managed.domain.sessionId)throw TypeError('Original managed Team caller required');return caller}}:{}),
      resolveCaller: (exec: ToolExec) => resolveTeamCaller(exec, teamId, state, sub, roster),
      roster,
      mailbox,
      taskBoard,
      activity,
    }
    const collisions = new Set(["send_message", "followup_task", "wait_agent", "interrupt_agent"])
    const teamTools = createTeamTools(toolDeps).map(tool=>({...tool,execute:(args:unknown,exec:ToolExec)=>{if(phase!=='open')throw Object.assign(Error('Team recovery required'),{code:'FACT_RECOVERY_REQUIRED'});return lead!.run(exec.abortSignal,()=>Promise.resolve(tool.execute(args,exec)))}})).map((tool) => deps.preserveSubagentTools && collisions.has(tool.name)
      ? { ...tool, name: `team_${tool.name}` } : tool)
    if(managed){launchTool=teamTools.find(tool=>tool.name==='spawn_teammate');if(!launchTool)throw TypeError('Original Team leaf unavailable');teamEntry=bindPreparedTeamLaunchLeaf(launchTool,launchTool.execute,provisioningOwner!)}
    // Tool names DERIVED from the created tools (Ruling 19) — mount and
    // unmount can never drift from each other or from Task 9's surface.
    teamToolNames = teamTools.map((t) => t.name)
    // Minor 5: the teammate role's tool surface derives from the SAME tool
    // list — all team tools minus the two Lead-only ones (spawn_teammate /
    // interrupt_agent). Never hardcode the 10 names in two places.
    teamRoleTools = [...TEAMMATE_BASE_TOOLS, ...(tools.get("shell") ? ["shell"] : []), ...teamToolNames.filter((n) => n !== "spawn_teammate" && n !== "interrupt_agent" && n !== "team_interrupt_agent")]
    // A restored child retains roleName="teammate" and rebuilds through the
    // shared registry. Publish the generated live role without saving it as a
    // user role; an existing custom definition remains authoritative.
    if (!sub.roles.get(TEAMMATE_ROLE_NAME)) {
      generatedRole = teammateRole(teamRoleTools)
      sub.roles.register(generatedRole, cleanup => { generatedRoleCleanup = cleanup })
    }

    // ---- recovery (crash restore), BEFORE the tools are live ----
    // (a) reconcile stuck provisioning members (provisioning→active if the
    //     child session is durable, else failed) — CROSS-TASK CARRY (Ruling 11).
    if(!managed)await lead.withoutRun(() => roster.reconcileProvisioning())
    assertConstructing()
    // (b) replay queued−delivered messages to their targets (at-least-once).
    if(!managed)await lead.withoutRun(() => mailbox!.recoverRoot())
    assertConstructing()

    // ---- register the tools ----
    toolMount = mountTeamTools(tools, teamTools, state, sub, toolDeps)
    toolMount.mount()
    if(managed){resumeRecovery=async()=>{if(phase==='partial')phase='constructing';try{for(const resource of coldResources){await resource.close();coldResources.delete(resource)}await lead!.withoutRun(() => roster.reconcileProvisioning());assertConstructing();await lead!.withoutRun(() => mailbox!.recoverRoot());assertConstructing();phase='open'}catch(error){if(!isRetired())phase='partial';throw error}};await driveRecovery()}
    else phase = 'open'
    return handle
  } catch (err) {
    if(managed&&resumeRecovery&&!isRetired()&&[...initialPending].some(name=>state.members.get(name)?.phase==='active'))throw new TeamMountRecoveryRequired(err,handle)
    try { await handle.unmount() }
    catch (cleanup) { throw new TeamMountFailure(err, cleanup, handle) }
    throw err
  }
}
