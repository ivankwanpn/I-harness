import { assertInitialTaskAdmission } from '../task/cold-bindings.ts'
import { publishChildResult } from "../child/result.ts"
import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { subagentFactOwner } from '../facts.ts'
import { createSpawnSource, spawnObservation } from './spawn-source.ts'
import { backgroundEventForTool, userSteerForTool, waitForObservation } from "@i-harness/core-tools"
import { declaredRoleModel, spawnChild, subagentModelSelectionDisabled, subagentModelSelectionGated } from "../child.ts"
import { TaskIdentityConflictError, type TaskIdentity, type TaskOutcome, type TaskRecord } from "../task-protocol.ts"
import { residentOwnerFor } from '../followup/resident-lifetime.ts'
import {bootstrapTaskChild,prepareOriginalTaskChildHost} from '../child/task-birth.ts'

export function createSpawnTool(deps: SubagentToolDeps): Tool {
  const spawnDescription = "Launch a subagent. Returns an agent path, job id, and durable task id immediately (background: true, default). With background: false the call waits for the task's summary; new user input can yield the wait while the same task continues. A deadline returns timed_out: true while the task is still running."
  const builtinGuidance = new Map([
    ["explore", "fast read-only code navigation"],
    ["research", "deep evidence-based analysis"],
    ["worker", "code changes, tests, and verification"],
    ["general", "broad mixed-scope work"],
  ])
  const baseSpawnSchema = {
    type: "object" as const,
    properties: {
      message: { type: "string", description: "Initial task for the subagent." },
      task_name: { type: "string", description: "Short name used in the agent path." },
      agent_type: { type: "string", description: "Choose an exact available role name for this task. If omitted, legacy calls use general." },
      fork_turns: { type: ["string", "number"], description: "Parent history to inherit: none (default), all, or a positive number of turns. Inherited history is parent context; the child's role still restricts its tools." },
      background: { type: "boolean", description: "false = block until the task settles (escape hatch); default true = return immediately and notify the parent on completion." },
    },
    required: ["message", "task_name"],
  }
  let metadataRevision = -1
  // Admission is a per-parent queue, like opencode's background job queue and
  // Codex's thread registry: the child still runs concurrently once launched,
  // but the parent-side admission (task record, subagent/start, birth and task
  // document save) runs one call at a time. The parent has a single-writer
  // execution contract; two concurrent admissions interleaved their writes and
  // the loser left an unresolved write that poisoned every later spawn.
  let admissionTail: Promise<void> = Promise.resolve()
  function withAdmission<T>(work: () => Promise<T>): Promise<T> {
    const previous = admissionTail
    let release!: () => void
    admissionTail = new Promise<void>(resolve => { release = resolve })
    return previous.catch(() => {}).then(work).finally(release)
  }
  let roleDescription = ""
  let roleInputSchema: typeof baseSpawnSchema = baseSpawnSchema
  const roleMetadata = () => {
    const revision = deps.roles.revision()
    if (revision !== metadataRevision) {
      const roles = deps.roles.list().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const choices = roles.filter(role => builtinGuidance.has(role.name)).map(role => `${role.name} for ${builtinGuidance.get(role.name)}`)
      const roleGuidance = `Choose agent_type intentionally${choices.length ? `: ${choices.join("; ")}` : ""}. A role selects capabilities; its configured model is resolved separately.`
      const catalog = roles.map(role => {
        const description = role.description.trim().replace(/\s+/g, " ")
        return `${role.name}: ${description}${role.name === "reviewer" ? " (approval guardian for pending tool actions, not a routine code-review worker)" : ""}`
      }).join("; ")
      roleDescription = `${spawnDescription}\n\n${roleGuidance}\nAvailable roles (use exact names): ${catalog || "none"}.`
      roleInputSchema = {
        ...baseSpawnSchema,
        properties: {
          ...baseSpawnSchema.properties,
          agent_type: { ...baseSpawnSchema.properties.agent_type, description: `${baseSpawnSchema.properties.agent_type.description} Available roles (exact names): ${roles.map(role => role.name).join(", ") || "none"}.` },
        },
      }
      metadataRevision = revision
    }
    return { description: roleDescription, inputSchema: roleInputSchema }
  }
  const spawnTool: Tool<
    { message: string; task_name: string; agent_type?: string; fork_turns?: string | number; background?: boolean },
    { agent_path: string; job_id: string; task_id: string; status?: string; outcome?: string; resultText?: string; error?: string; message?: string; timed_out?: boolean; yielded?: true; yield_reason?: "user-steer" | "background-event" }
  > = {
    name: "spawn_agent",
    get description() { return roleMetadata().description },
    get inputSchema() { return roleMetadata().inputSchema },
    isReadOnly: false,
    execute: async (args, exec) => {
      if(deps.managedParent && args.background!==false && (!deps.parentNotify?.prepareTaskDelivery||!deps.parentNotify.admitTaskDelivery||!deps.parentNotify.taskEvidence))throw Error('Managed background Task delivery unavailable')
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}; register a capability definition with a system prompt and allowed tools. A model selection alone does not define a role.`)
      // M24a (B2): max_depth guard — reject spawning once the caller is already
      // at (or beyond) the nesting limit. Default 1 keeps today's behavior
      // (top-level callers are depth 0; subagents cannot nest).
      //
      // M24a (Ruling M24a-T2a, carried finding — DEPTH-BINDING LIMITATION,
      // documented per the minimal-diff ruling): this guard reads
      // deps.parentSession.header.delegationDepth, but the tool mount is
      // SHARED — registerSubagent mounts createSubagentTools ONCE on the host
      // registry with ONE bound parent session (the root; index.ts and
      // run.ts both mount the root session), so through today's mount every
      // caller resolves callerDepth from the ROOT session (depth 0). A
      // subagent that somehow reached this tool would therefore be measured at
      // depth 0, and a host-raised maxDepth > 1 would under-enforce. A
      // per-session createSubagentTools mount (rebinding deps.parentSession
      // per child scope) was evaluated and rejected for M24a: it restructures
      // tool mounting for every consumer. This is MOOT in the shipped surface:
      // the builtin roles (roles.ts) do not include spawn_agent in their
      // tools, so no subagent can reach this guard until a custom role adds
      // it — exactly the configuration a host must pair with a maxDepth
      // review.
      let observation=deps.managedParent?.execution.observe()
      if(deps.managedParent){
        try{observation=deps.managedParent.execution.observe()}
        catch(error){
          // A previous child start can leave exact-cleanup debt; retry that
          // cleanup once before failing the new spawn (the workspace would
          // otherwise stay wedged for every later write).
          if(!/dependency cleanup unresolved|issued write needs reconciliation/i.test(String((error as Error)?.message??error)))throw error
          await (await import('@i-harness/core-session/internal/execution')).settleManagedExecutionDependencies(deps.managedParent.domain)
          observation=deps.managedParent.execution.observe()
        }
      }
      if(observation){if(observation.identity!==deps.managedParent!.domain.identity)throw Error('Foreign parent observation');observation.assertCurrent()}
      const callerDepth = (observation?.header ?? deps.parentSession?.header)?.delegationDepth ?? 0
      const maxDepth = deps.maxDepth ?? 1
      if (callerDepth >= maxDepth) {
        throw new Error(`subagent nesting depth limit reached (max ${maxDepth}) — cannot spawn from depth ${callerDepth}`)
      }
      // `plugins.subagentModel`, as a PRECONDITION — the same refusal spawnChild
      // makes (same helper, same message), asked here so a refused spawn writes
      // nothing durable: below this line the call submits a task record and
      // appends `subagent/start`, and a refusal that had already done that would
      // leave an accepted task with no child behind it.
      const turns = parseForkTurns(args.fork_turns)
      const identity: TaskIdentity = {
        parentSessionId: exec?.sessionId ?? deps.childSessions?.parentSessionId ?? "",
        ...(exec?.callEventSeq !== undefined ? { callEventSeq: exec.callEventSeq } : {}),
        ...(exec?.callId !== undefined ? { toolCallId: exec.callId } : {}),
      }
      assertInitialTaskAdmission(deps.tasks, identity)
      // Only the already-known, callback-free refusal can precede admission.
      // Dynamic selection/policy still belongs to the installed original slot.
      if(!deps.roleSelectionFor&&typeof deps.allowSubagentModelSelection!=='function'&&subagentModelSelectionGated(deps,role.model))throw subagentModelSelectionDisabled(role.name)
      const admitted=deps.taskLaunchCallerFor?.(exec)
      if(admitted?.kind==='same')return admitted.slot.flight
      const originalSlot=admitted?.slot
      const runBody=async()=>{
      const role=originalSlot?.role??deps.roles.get(args.agent_type??'general')!
      const declared=originalSlot?originalSlot.captureSelection(()=>declaredRoleModel(role,deps)):declaredRoleModel(role,deps)
      if(subagentModelSelectionGated(deps,declared))throw subagentModelSelectionDisabled(role.name)
      const host=originalSlot?await prepareOriginalTaskChildHost(originalSlot,deps):undefined
      const delivery = args.background === false ? "tool" : "parent"
      // M26-D1 三元 identity（exact-semantics 表）：callEventSeq 唯一；toolCallId 隨身。
      let unregisterDelivery: (() => void) | undefined
      const retained=exec.retainOutcome?.()
      let cleanupSource:ReturnType<typeof createSpawnSource>|undefined,retainedClosed=false
      const closeRetained=()=>{if(!retainedClosed){if(!cleanupSource?.hasPublished())retained?.unavailable();retainedClosed=true}}
      originalSlot?.keep({async close(){closeRetained()}})
      const source = createSpawnSource(deps.managedParent?.domain.owner ?? subagentFactOwner(deps.parentSession!, deps.factOwner), exec.abortSignal, retained, args.background !== false,
        () => { unregisterDelivery?.(); deps.onTaskTerminalCommitted?.() }, deps.onTaskTerminalRecovery,originalSlot?cleanup=>originalSlot.keep(cleanup):undefined,deps.managedParent?.domain)
      cleanupSource=source
      // A nested spawn belongs under the CALLER's path, not always under root.
      // Cancel and projection walk the agentPath prefix tree, so a flat
      // "root/<name>" made stop_task unable to reach grandchildren and made two
      // same-named tasks under different parents collide.
      const callerEntry = [...deps.table.entries().values()].find(entry => entry.sessionId !== undefined && entry.sessionId === exec.sessionId)
      // Replay path: the task record already exists; stay under ITS parent.
      const reusedPath = originalSlot?.task.agentPath, reusedParent = reusedPath?.slice(0, reusedPath.lastIndexOf('/'))
      const parentPath = originalSlot ? (reusedParent || "root") : (callerEntry?.path ?? "root")
      let task: TaskRecord
      try {
        task = originalSlot?deps.tasks.get(originalSlot.task.id)!:deps.tasks.submit({
          identity,
          agentPath: `${parentPath}/${args.task_name}`,
          description: args.task_name,
          prompt: args.message,
          agent: role.name,
          delivery,
        })
      } catch (err) {
        await source.releaseUnused()
        source.finish()
        if (err instanceof TaskIdentityConflictError) throw new Error(`task identity conflict for this call: ${err.message}`)
        throw err
      }
      const retainTaskResult=()=>originalSlot?originalSlot.retainResult():deps.tasks.retainResult(task.id)
      source.bindTask(task.id, retainTaskResult)
      let observationAborted = false
      try {
        await source.bindRequiredTask(deps.tasks,task)
        const resultStore = await deps.tasks.prepareResult(task.id, exec, source.settlementHeld)
        // D-08: the durable job record (and parent journal) already cover this
        // spawn; a task-document write debt must not fail the spawn or block
        // unrelated tasks. The strict flush stays available to close paths.
        await (deps.tasks.flushPersistenceBestEffort?.() ?? deps.tasks.flushPersistence().then(() => ({ ok: true }), error => ({ ok: false, error })))
        const preparation = exec.resultConsumer !== 'code' && exec.session === deps.parentSession
          && exec.sessionId === deps.childSessions?.parentSessionId && deps.notificationNamespace && exec.callEventSeq !== undefined
          ? await deps.parentNotify?.prepareTaskDelivery?.({ sessionId: exec.sessionId!, namespace: deps.notificationNamespace, taskId: task.id, callSeq: exec.callEventSeq }) : undefined
        if (preparation?.kind === 'bound') originalSlot?.acknowledgeDelivery(preparation)
        if (preparation?.kind === 'bound') unregisterDelivery = deps.registerDeliverySource?.(task.id, source)
        const startReceipt=await source.start({ type: "subagent/start", version: 1, taskId: task.id, agentPath: task.agentPath, role: role.name, description: args.task_name, ...(identity.parentSessionId !== "" ? { parentSessionId: identity.parentSessionId } : {}) }, preparation?.kind === 'bound' ? preparation.binding : undefined)
        originalSlot?.acknowledgeStart(startReceipt)
        if (preparation?.kind === 'bound' && delivery === 'tool') source.bindHandoff(deps.tasks.bindForegroundHandoff(task.id))
        const birth=originalSlot?await bootstrapTaskChild(originalSlot,deps,declared,host!):undefined
        const executed = await spawnChild({
          ...(birth?{childStart:{kind:'committed-child-birth' as const,birth}}:{}),
          signal: exec.abortSignal,
          generationFactoryFor: deps.generationFactoryFor, modelActionTimeoutMs: deps.modelActionTimeoutMs, modelActionMaxAttempts: deps.modelActionMaxAttempts,
          taskName: args.task_name,
          message: args.message,
          parentPath,
          parentRegistry: deps.parentRegistry,
          parentSession: deps.parentSession,
          parentCtx: deps.parentCtx,
          ...(deps.childShellFactory ? { childShellFactory: deps.childShellFactory } : {}),
          role: deps.roleToolsFor?.(role.name) === undefined ? role : { ...role, tools: deps.roleToolsFor!(role.name)! },
          parentModel: deps.parentModel,
          codeMode: deps.codeMode, codeModeFactory: deps.codeModeFactory,
          createInstructionContext: deps.createInstructionContext,
          retainInitialSetup: setup => {originalSlot?.keep({close:setup.close.bind(setup)});return residentOwnerFor(deps).retainInitial(setup)},
          retainPublication: originalSlot?phase=>{
            originalSlot.retainPublication(phase)
            if(phase.kind==='entry'){const entry=phase.value as import('../agent-table.ts').ChildAgentEntry,close=entry.dispose!.bind(entry);originalSlot.keep({close})}
            if(phase.kind==='job'){const job=phase.value as import('../jobs.ts').JobRegistration;originalSlot.keep({async close(){job.finish?.('error','Original child launch retired')}})}
            if(phase.kind==='agent'){const agent=phase.value as import('@i-harness/core-agent').Agent,id=originalSlot.task.childBirth!.request.invocation.targetSessionId;originalSlot.keep({async close(){if(deps.agents.get(id)===agent)deps.agents.remove(id)}})}
          }:undefined,
          onEntryPublished: originalSlot?(_entry,info)=>{originalSlot.published();deps.tasks.claim(task.id,info.sessionId,info.modelLabel,info.jobId)}:undefined,
          resolveModel: deps.resolveModel,
          // Forwarded with the resolver so spawnChild decides the role's model for
          // EVERY spawn site (this tool's precondition above only exists to refuse
          // before the task record is written). See child.ts for the rule.
          roleSelectionFor: deps.roleSelectionFor,
          allowSubagentModelSelection: deps.allowSubagentModelSelection,
          ...(deps.autoCompactionEnabled ? { autoCompactionEnabled: deps.autoCompactionEnabled } : {}),
          ...(deps.inheritedSystemContext ? { inheritedSystemContext: deps.inheritedSystemContext } : {}),
          // M73: the session's own window and cap, forwarded to the spawn. Without
          // this hop the values reach SubagentToolDeps and stop — an inheriting
          // child of THIS tool would carry neither while every type still checks,
          // which is the failure mode hardest to see: the precedence is right and
          // both numbers are empty. Absent stays absent (no key written).
          ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
          budgetBinding: deps.budgetBinding, contextMetadata: deps.contextMetadata, reasoningEffort: deps.reasoningEffort,
          inheritedBindingForStep: deps.inheritedBindingForStep,
          summaryFactory: deps.summaryFactory,
          results: resultStore ?? deps.results,
          ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
          jobs: deps.jobs,
          table: deps.table,
          agents: deps.agents,
          forkTurns: turns,
          childSessions: deps.childSessions,
          validateBeforeLaunch: source.assertLaunch,
          onPublished: source.published,
          onSettled: async (info) => {

            source.settling()
            // M26-D1: settle → terminalize（interrupt 中止的初始 turn 視為 cancelled——
            // 被等待的回答不會到來；後續 followup 沿用 M9 job 流，不再入本 task）。
            const outcome: TaskOutcome = info.aborted
              ? "cancelled"
              : info.error !== undefined && info.finalText === undefined
                ? "error"
                : "completed"
            let originalTerminal:Readonly<TaskRecord>|undefined
            try {
              const terminalInput = {
                taskId: task.id,
                outcome,
                ...(info.finalText !== undefined ? { resultText: info.finalText } : {}),
                ...(info.error !== undefined ? { error: info.error } : {}),
              };originalTerminal=await source.terminalizeOriginal(terminalInput);if(!originalTerminal)deps.tasks.terminalize(terminalInput)
            } catch (error) {
              if(!source.hasRequiredTask())source.failed(error, Object.freeze({ ...info }))
              throw error
            }
            const observedEntry = deps.table.get(task.agentPath)
            const observedTask = originalTerminal??deps.tasks.get(task.id)!
            if (!originalTerminal && observedEntry && observedTask.result) publishChildResult(deps, observedEntry, observedTask, observedTask.outcome ?? outcome, task.id)
            // subagent/end —— parent 側的 durable 記號（D2 通知的資料源）。
            // 若已被 stop_task/close_agent 先行終態化（cancelTree 寫入 cancelled），
            // 本次 terminalize 為 no-op（CAS），但仍據 record 現值 append。
            await source.prepareEnd(async () => {
              if(!await source.terminalizeOriginal({taskId:task.id,outcome}))await retainTaskResult()
              const settled = originalTerminal??deps.tasks.get(task.id)!
              if (!originalTerminal && observedEntry && settled.result) publishChildResult(deps, observedEntry, settled, settled.outcome ?? outcome, task.id)
              return { event: {
                type: "subagent/end", version: 1, taskId: task.id, outcome: settled.outcome ?? outcome,
                ...(settled.result?.kind === "retained" ? { envelope: settled.result.envelope, resultRevision: settled.result.revision } : {}),
                ...(settled.resultText !== undefined ? { resultText: settled.resultText } : {}),
                ...(settled.error !== undefined ? { error: settled.error } : {}),
              }, output: spawnObservation(source.identity(), settled) }
            })
            const settled = originalTerminal??deps.tasks.get(task.id)!
            return settled
          },
        })
        // WHY: child.ts:340 spells the resolved label; task-protocol.ts:150 keeps
        // it in the task snapshot, so closing a live entry cannot erase the evidence.
        if(!originalSlot)deps.tasks.claim(task.id, executed.sessionId, executed.modelLabel, executed.jobId)
        const base = source.identity()
        if (args.background === false) {
          const reason = await waitForObservation({
            ready: () => deps.tasks.get(task.id)?.outcome !== undefined,
            changes: { subscribe: wake => deps.tasks.subscribe(task.id, wake) },
            timeoutMs: deps.foregroundWaitMs ?? 300_000,
            abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec), backgroundEvent: backgroundEventForTool(exec),
          }).catch(error => {
            if (exec.abortSignal?.aborted && error === exec.abortSignal.reason) observationAborted = true
            throw error
          })
          if (exec.abortSignal?.aborted) {
            observationAborted = true
            exec.abortSignal.throwIfAborted()
          }
          let settled = deps.tasks.get(task.id)
          if (settled?.outcome === undefined) {
            if (preparation?.kind === 'bound') {
              // Reserve this source's handoff now. Its original save joins all
              // earlier FIFO work without waiting for unrelated future saves.
              const route = await source.handoffToParent()
              if (exec.abortSignal?.aborted) { source.abandonHandoff(); observationAborted = true; exec.abortSignal.throwIfAborted() }
              if (route === 'ready') return await source.foreground()
              if (route === 'parent') { source.assertHandoff(); source.consumeHandoff() }
              settled = deps.tasks.get(task.id)
            }
            const steered = reason === "user-steer" || reason === "background-event"
            return { ...base, status: settled?.status ?? "unknown",
              message: steered ? `wait yielded to ${reason === "background-event" ? "a background completion" : "new user input"} for ${executed.path}` : `wait timed out for ${executed.path}`,
              timed_out: reason === "deadline", ...(steered ? { yielded: true as const, yield_reason: reason } : {}) }
          }
          return await source.foreground()
        }
        return base
      } catch (error) {
        originalSlot?.retire(error)
        if (/Earlier owned task save requires resolution/i.test(error instanceof Error ? error.message : String(error))) {
          try { await deps.tasks.recoverPersistence() } catch { /* terminalize still reports the original refusal */ }
        }
        if (source.hasPublished()) {
          if (observationAborted) throw error
          throw source.recoverPublished(error)
        }
        const outcome = exec.abortSignal?.aborted ? 'cancelled' as const : 'error' as const
        const failures: unknown[] = [error]
        try {
          const input={taskId:task.id,outcome,error:error instanceof Error?error.message:String(error)};if(!await source.terminalizeOriginal(input))deps.tasks.terminalize(input)
        } catch (failure) { if(!source.hasRequiredTask())source.failed(failure, Object.freeze({ outcome, error })); failures.push(failure) }
        const settled = deps.tasks.get(task.id)
        if (settled?.outcome !== undefined) {
          try {
            await source.end({
              type: 'subagent/end', version: 1, taskId: task.id, outcome: settled.outcome,
              ...(settled.result?.kind === "retained" ? { envelope: settled.result.envelope, resultRevision: settled.result.revision } : {}),
              ...(settled.resultText !== undefined ? { resultText: settled.resultText } : {}),
              ...(settled.error !== undefined ? { error: settled.error } : {}),
            })
          } catch (failure) { failures.push(failure) }
        }
        if (failures.length > 1) throw Object.assign(new AggregateError(failures, 'Spawn refusal needs recovery'), { code: 'FACT_RECOVERY_REQUIRED', cause: error })
        throw error
      }
      finally { try{if(originalSlot)closeRetained()}finally{source.finish()} }
      }
      const run=()=>withAdmission(runBody)
      if(originalSlot){originalSlot.start(run);return originalSlot.flight}
      return run()
    },
  }
  return spawnTool
}

function parseForkTurns(value: string | number | undefined): "none" | "all" | number {
  if (value === undefined || value === "none") return "none"
  if (value === "all") return "all"
  const n = typeof value === "number" ? value : Number(value)
  if (Number.isInteger(n) && n > 0) return n
  throw new Error("fork_turns must be none, all, or a positive integer")
}
