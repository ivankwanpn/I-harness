import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { subagentFactOwner } from '../facts.ts'
import { createSpawnSource, spawnObservation } from './spawn-source.ts'
import { userSteerForTool, waitForObservation } from "@i-harness/core-tools"
import { declaredRoleModel, spawnChild, subagentModelSelectionDisabled, subagentModelSelectionGated } from "../child.ts"
import { TaskIdentityConflictError, type TaskIdentity, type TaskOutcome, type TaskRecord } from "../task-protocol.ts"

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
    { agent_path: string; job_id: string; task_id: string; status?: string; outcome?: string; resultText?: string; error?: string; message?: string; timed_out?: boolean; yielded?: true; yield_reason?: "user-steer" }
  > = {
    name: "spawn_agent",
    get description() { return roleMetadata().description },
    get inputSchema() { return roleMetadata().inputSchema },
    isReadOnly: false,
    execute: async (args, exec) => {
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
      const callerDepth = deps.parentSession.header?.delegationDepth ?? 0
      const maxDepth = deps.maxDepth ?? 1
      if (callerDepth >= maxDepth) {
        throw new Error(`subagent nesting depth limit reached (max ${maxDepth}) — cannot spawn from depth ${callerDepth}`)
      }
      // `plugins.subagentModel`, as a PRECONDITION — the same refusal spawnChild
      // makes (same helper, same message), asked here so a refused spawn writes
      // nothing durable: below this line the call submits a task record and
      // appends `subagent/start`, and a refusal that had already done that would
      // leave an accepted task with no child behind it.
      const declared = declaredRoleModel(role, deps)
      if (subagentModelSelectionGated(deps, declared)) throw subagentModelSelectionDisabled(role.name)
      const turns = parseForkTurns(args.fork_turns)
      const delivery = args.background === false ? "tool" : "parent"
      // M26-D1 三元 identity（exact-semantics 表）：callEventSeq 唯一；toolCallId 隨身。
      const identity: TaskIdentity = {
        parentSessionId: exec?.sessionId ?? deps.childSessions?.parentSessionId ?? "",
        ...(exec?.callEventSeq !== undefined ? { callEventSeq: exec.callEventSeq } : {}),
        ...(exec?.callId !== undefined ? { toolCallId: exec.callId } : {}),
      }
      const source = createSpawnSource(subagentFactOwner(deps.parentSession, deps.factOwner), exec.abortSignal, exec.retainOutcome?.(), args.background !== false)
      let task: TaskRecord
      try {
        task = deps.tasks.submit({
          identity,
          agentPath: `root/${args.task_name}`,
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
      source.bindTask(task.id, () => deps.tasks.flushPersistence())
      let observationAborted = false
      try {
        await deps.tasks.flushPersistence()
        await source.start({ type: "subagent/start", version: 1, taskId: task.id, agentPath: task.agentPath, role: role.name, description: args.task_name, ...(identity.parentSessionId !== "" ? { parentSessionId: identity.parentSessionId } : {}) })
        const executed = await spawnChild({
          signal: exec.abortSignal,
          generationFactoryFor: deps.generationFactoryFor, modelActionTimeoutMs: deps.modelActionTimeoutMs, modelActionMaxAttempts: deps.modelActionMaxAttempts,
          taskName: args.task_name,
          message: args.message,
          parentPath: "root",
          parentRegistry: deps.parentRegistry,
          parentSession: deps.parentSession,
          parentCtx: deps.parentCtx,
          role,
          parentModel: deps.parentModel,
          codeMode: deps.codeMode, codeModeFactory: deps.codeModeFactory,
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
          ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
          jobs: deps.jobs,
          table: deps.table,
          agents: deps.agents,
          forkTurns: turns,
          childSessions: deps.childSessions,
          validateBeforeLaunch: source.assertLaunch,
          onPublished: source.published,
          onSettled: async (info) => {
            // M26-D1: settle → terminalize（interrupt 中止的初始 turn 視為 cancelled——
            // 被等待的回答不會到來；後續 followup 沿用 M9 job 流，不再入本 task）。
            const outcome: TaskOutcome = info.aborted
              ? "cancelled"
              : info.error !== undefined && info.finalText === undefined
                ? "error"
                : "completed"
            try {
              deps.tasks.terminalize({
                taskId: task.id,
                outcome,
                ...(info.finalText !== undefined ? { resultText: info.finalText } : {}),
                ...(info.error !== undefined ? { error: info.error } : {}),
              })
            } catch (error) {
              source.failed(error, Object.freeze({ ...info }))
              throw error
            }
            // subagent/end —— parent 側的 durable 記號（D2 通知的資料源）。
            // 若已被 stop_task/close_agent 先行終態化（cancelTree 寫入 cancelled），
            // 本次 terminalize 為 no-op（CAS），但仍據 record 現值 append。
            const settled = deps.tasks.get(task.id)!
            await source.end({
              type: "subagent/end", version: 1, taskId: task.id,
              outcome: settled.outcome ?? outcome,
              ...(settled.resultText !== undefined ? { resultText: settled.resultText } : {}),
              ...(settled.error !== undefined ? { error: settled.error } : {}),
            }, spawnObservation(source.identity(), settled))
          },
        })
        // WHY: child.ts:340 spells the resolved label; task-protocol.ts:150 keeps
        // it in the task snapshot, so closing a live entry cannot erase the evidence.
        deps.tasks.claim(task.id, executed.sessionId, executed.modelLabel)
        const base = source.identity()
        if (args.background === false) {
          const reason = await waitForObservation({
            ready: () => deps.tasks.get(task.id)?.outcome !== undefined,
            changes: { subscribe: wake => deps.tasks.subscribe(task.id, wake) },
            timeoutMs: deps.foregroundWaitMs ?? 300_000,
            abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
          }).catch(error => {
            if (exec.abortSignal?.aborted && error === exec.abortSignal.reason) observationAborted = true
            throw error
          })
          if (exec.abortSignal?.aborted) {
            observationAborted = true
            exec.abortSignal.throwIfAborted()
          }
          const settled = deps.tasks.get(task.id)
          if (settled?.outcome === undefined) {
            const steered = reason === "user-steer"
            return { ...base, status: settled?.status ?? "unknown",
              message: steered ? `wait yielded to new user input for ${executed.path} (still running)` : `wait timed out for ${executed.path} (still running)`,
              timed_out: reason === "deadline", ...(steered ? { yielded: true as const, yield_reason: "user-steer" as const } : {}) }
          }
          return await source.foreground()
        }
        return base
      } catch (error) {
        if (source.hasPublished()) {
          if (observationAborted) throw error
          throw source.recoverPublished(error)
        }
        const outcome = exec.abortSignal?.aborted ? 'cancelled' as const : 'error' as const
        const failures: unknown[] = [error]
        try {
          deps.tasks.terminalize({ taskId: task.id, outcome, error: error instanceof Error ? error.message : String(error) })
        } catch (failure) { source.failed(failure, Object.freeze({ outcome, error })); failures.push(failure) }
        const settled = deps.tasks.get(task.id)
        if (settled?.outcome !== undefined) {
          try {
            await source.end({
              type: 'subagent/end', version: 1, taskId: task.id, outcome: settled.outcome,
              ...(settled.resultText !== undefined ? { resultText: settled.resultText } : {}),
              ...(settled.error !== undefined ? { error: settled.error } : {}),
            })
          } catch (failure) { failures.push(failure) }
        }
        if (failures.length > 1) throw Object.assign(new AggregateError(failures, 'Spawn refusal needs recovery'), { code: 'FACT_RECOVERY_REQUIRED', cause: error })
        throw error
      }
      finally { source.finish() }
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
