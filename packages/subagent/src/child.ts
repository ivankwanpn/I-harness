import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry, type ToolRegistry } from "@i-harness/core-tools"
import { createAgent, type AgentRegistry, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
// Type-only: the selection's per-row protocol is the SAME closed set settings
// validates (`SettingsProviderProtocol`) — a fourth copy of the five names would
// be a fourth place to edit one enum. Erased at build time, no runtime edge.
import type { SettingsProviderProtocol } from "@i-harness/settings"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { diagnosticsFor } from "@i-harness/diagnostics"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable } from "./agent-table.ts"
import { builtinRoles, type SubagentRole } from "./roles.ts"
import { forkTurns } from "./fork.ts"

// W6 T6: ONE module-scope handle for this file's one report, and the phase is
// `run`: the message is the spawn path's own — a role's declared tool is
// absent from the parent registry, so the child RUNS without it (a spawned
// child is a run of its own; the parent's turn is where the spawn happens).
// With nothing installed the handle delegates to console.warn verbatim (one
// argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("run")

/**
 * M49 Task 14 (spec §11): the subagent prompt contract — appended AFTER the
 * role prompt on every child agent. It carries the delegated-task scope, the
 * no-recursive-delegation rule, the changed-files/test reporting and the
 * result delivery; the closing note keeps human/project instructions (the
 * task message, project rules) above this contract.
 */
export const SUBAGENT_PROMPT_CONTRACT = `Subagent contract:
- Scope: complete the delegated task only; do not expand into adjacent work.
  Your task scope is exactly what was asked of you. The parent owns the
  overall plan — ask about ambiguity instead of assuming scope.
- Delegation: do not delegate recursively unless the harness explicitly
  supports it. Use the tools you were given; your tools list is the authority.
- Reporting: in your final result, report the changed files and the tests you
  ran or added, with their outcomes.
- Result delivery: deliver the concrete deliverable of your task in your final
  message. The parent integrates your result into its own work — do not
  repeat work the parent already owns.
Note: human and project instructions (your task message, project rules, and
the role prompt above) remain higher priority than this contract.`

/** Role system prompt + the subagent contract (the child agent's system
 * prompt). The role prompt always leads; the contract follows. */
export function composeSubagentPrompt(roleSystemPrompt: string): string {
  return `${roleSystemPrompt}\n\n${SUBAGENT_PROMPT_CONTRACT}`
}

/**
 * Register a role's declared tools onto a child registry, resolved from the
 * parent. Returns the declared names that resolved to NOTHING.
 *
 * The drop is reported rather than performed in silence. A role's `tools` list
 * is a RESTRICTION — the child gets exactly these and no others — so a name
 * that matches no mounted tool silently narrows the child below what its role
 * declares, and no surface showed it: the role registered, the table listed it,
 * and the agent simply could not do the thing. (Two identical copies of the
 * silent loop lived in child.ts and tools.ts; a plugin agent declaring Claude
 * Code's `Read`/`Glob`/`Grep` vocabulary against this repo's lowercase registry
 * would have hit it on every entry.)
 *
 * Deliberately a warn, NOT a throw — unlike the unknown-provider case a few
 * lines below, which does throw. The two look symmetric but are not: a role
 * naming a provider that does not exist cannot run at all, whereas a role with
 * ONE unmounted tool still runs and simply has less to work with. A host that
 * mounts no `pwsh` must still be able to spawn its builtin roles.
 */
export function resolveRoleTools(
  roleName: string,
  declared: string[],
  parent: ToolRegistry,
  child: ToolRegistry,
): string[] {
  const missing: string[] = []
  for (const name of declared) {
    const tool = parent.get(name)
    if (tool) child.register(tool)
    else missing.push(name)
  }
  if (missing.length > 0) {
    d.warn(
      `[subagent] role '${roleName}' declares ${missing.length} tool(s) absent from the parent registry; ` +
        `the child runs without them: ${missing.join(", ")}`,
    )
  }
  return missing
}

/** A role's model selection: which route, which model, and optionally the wire
 * protocol / reasoning effort the role asks for. A settings
 * `agents.roles.<name>` entry satisfies this shape structurally — nothing in
 * this package names that type. */
export interface RoleModelSelection {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

/** The host's side of the rule: the declared role models, read through a
 * CALLBACK at spawn time so a settings edit applies to the next spawn without
 * restarting the session, and `plugins.subagentModel` — the switch that lets a
 * role run on a declared model at all. `SpawnOptions`, the subagent tool deps
 * and `RegisterSubagentOptions` all carry this shape, so it is written here
 * ONCE and the rule below is stated once. */
export interface RoleModelHost {
  /** Settings' `agents.roles.<name>` (or any host's equivalent): the model the
   * host declares for a role. Absent → the role's own `model`, then inherit. */
  roleSelectionFor?: (roleName: string) => RoleModelSelection | undefined
  /** The switch. ABSENT MEANS OFF — the setting's own default is false, and a
   * host that never wired it has not enabled the feature. Off, a declared
   * selection is refused (`subagentModelSelectionGated`) rather than run. */
  allowSubagentModelSelection?: boolean
}

/** The role's model for THIS spawn, in order: the HOST's declared
 * `agents.roles.<name>` selection, then the role's own `model` (the session
 * snapshot / plugin path), then nothing — inherit the parent's client, which is
 * what an unconfigured harness does and what every role did before this section
 * existed. Settings wins because it is the host's deliberate decision, while a
 * snapshot role is per-session residue.
 *
 * Pure: whether a returned selection may actually run is the switch's question
 * (`subagentModelSelectionGated`) — the two are separate so the refusing call
 * sites can fail in their own vocabulary (throw for a spawn, `false` for a
 * lazy rebuild) without a second copy of the ordering. */
export function declaredRoleModel(role: SubagentRole, host: RoleModelHost): RoleModelSelection | undefined {
  return host.roleSelectionFor?.(role.name) ?? role.model
}

/** The recorded label for a resolved selection — `provider:model`, the ONE
 * spelling of that pair. `spawnChild` and the resident rebuild
 * (`ensureResidentAgent`) both RECORD what the child runs on; a second copy of
 * this expression would be a second place for the two records to drift. */
export function modelLabelOf(selection: RoleModelSelection): string {
  return `${selection.provider}:${selection.model}`
}

/** The four built-in names, read from the ONE place that declares them
 * (`builtinRoles`). The refusal below picks its second repair by this set: the
 * CLI's `roles unset` accepts no other name, so offering it for a
 * plugin-contributed role or the guardian's `reviewer` sent the reader to a
 * verb that exits 1 with "unknown role". */
const BUILTIN_ROLE_NAMES = new Set(builtinRoles().map((role) => role.name))

/** The ONE refusal for a gated selection — shared by the spawn path, the
 * restored resident rebuild and `resume_agent`'s diagnostic, so the message
 * cannot drift between them. It names BOTH fixes because the reader has both at
 * hand: turn the switch on, or clear the role's model — and the second names
 * the surface that can actually clear THIS name, since `roles unset` only
 * accepts the four built-ins. */
export function subagentModelSelectionDisabled(roleName: string): Error {
  const clear = BUILTIN_ROLE_NAMES.has(roleName)
    ? `clear it with \`i-harness roles unset ${roleName}\``
    : `clear \`agents.roles.${roleName}\` in settings.json`
  return new Error(
    `role "${roleName}" declares a model, but sub-agent model selection is disabled: ` +
      `set plugins.subagentModel=true in settings, or ${clear}`,
  )
}

/** True when a declared selection must be refused: the switch is on ONLY when
 * it is literally `true`. ABSENT is off — the setting's own default is false,
 * and a host that never wired the option has not enabled the feature. This is
 * the ONE place that rule is written. */
export function subagentModelSelectionGated(host: RoleModelHost, declared: RoleModelSelection | undefined): boolean {
  return declared !== undefined && host.allowSubagentModelSelection !== true
}

/** The resolver's answer, structurally: the `status` decides, and a `ready`
 * state's `client` and `reasoningEffort` are read here. provider-runtime's own
 * answer satisfies it as it stands (the field names and the three arms match) —
 * kept local because this package does not depend on provider-runtime, the same
 * reason session-executor declares its own binding result type. */
export type RoleModelState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: { client: ModelClient; reasoningEffort?: ReasoningEffort } }

export interface SpawnOptions extends RoleModelHost {
  taskName: string
  message: string
  parentPath: string
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  role: SubagentRole
  parentModel: ModelClient
  /** Resolve a selection to a live client through the HOST's provider plane —
   * the same one the session's own model went through, so a role gets the same
   * credentials, the same card table and the same protocol chain.
   *
   * It replaced a `ProviderRegistry` that `assembly.ts` built empty and nothing
   * ever registered into, which made `role.model` throw `references unknown
   * provider` for every value it could ever hold. */
  resolveModel(selection: RoleModelSelection): Promise<RoleModelState>
  jobs: JobRegistry
  table: AgentTable
  agents: AgentRegistry
  forkTurns?: "none" | "all" | number
  // M8: when present, the child session is durable — minted as child-<uuid>,
  // created through the coordinator with the lineage header, and mirrored to
  // the parent's write-behind coordinator.
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  // M26-D1: settle callback — fires once when the initial run settles (the
  // task protocol's spawn record transitions on it). Additive: absent = today.
  onSettled?: (info: { finalText?: string; error?: string; aborted: boolean }) => void
}

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string }> {
  // The model is decided (and gated) BEFORE anything is created: a refused
  // spawn leaves no child session, no table entry and no job behind.
  const declared = declaredRoleModel(opts.role, opts)
  if (subagentModelSelectionGated(opts, declared)) throw subagentModelSelectionDisabled(opts.role.name)

  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()

  // fork_turns: last N parent turns (default all). The seed events are the
  // child's inherited context; with persistence they are stored in the child's
  // log and seedLength marks the boundary (dsh lineage).
  const turns = opts.forkTurns ?? "all"
  const seedEvents = turns === "none" ? [] : forkTurns(opts.parentSession.events, turns === "all" ? Infinity : turns)

  let childSession: ReturnType<typeof createSession>
  let sessionId: string | undefined
  // M24a (B1): resolveChildDepth = delegationDepthOf(parent) + 1 — depth
  // recurses down the delegation chain (a child of a depth-1 subagent is
  // depth 2) instead of hardcoding 1. A headerless (root) parent is depth 0.
  const childDepth = (opts.parentSession.header?.delegationDepth ?? 0) + 1
  if (opts.childSessions) {
    sessionId = `child-${randomUUID()}`
    await opts.childSessions.coordinator.create({
      sessionId,
      parentSession: opts.childSessions.parentSessionId,
      seedLength: seedEvents.length,
      origin: "subagent",
      // dsh: resolveChildDepth = delegationDepthOf(parent) + 1 — a child of a
      // top-level (depth 0) session is depth 1.
      delegationDepth: childDepth,
    })
    childSession = createSession((ev) => {
      opts.childSessions!.coordinator.enqueue(sessionId!, [ev])
      if (ev.type === "turn/end") void opts.childSessions!.coordinator.flush(sessionId!).catch(() => {})
    })
    // Persist the seed through the mirror so the child log starts at seq 0
    // with the inherited context (dsh: seed events live in the child log).
    for (const ev of seedEvents) append(childSession, { ...ev })
    // dsh parent+1 rule: same depth as the coordinator.create lineage above.
    childSession.header = { parentSession: opts.childSessions.parentSessionId, seedLength: seedEvents.length, origin: "subagent", delegationDepth: childDepth }
  } else {
    childSession = createSession()
    for (const ev of seedEvents) childSession.events.push({ ...ev })
  }

  // child registry: register the role's allowed tools (resolved from the parent).
  // A declared tool the host does not mount is reported, never dropped silently.
  const childReg = createToolRegistry(childCtx)
  resolveRoleTools(opts.role.name, opts.role.tools, opts.parentRegistry, childReg)

  // model: the declared selection (settings first, then the role's own) through
  // the host's resolver, else inherit the parent's client — which is what an
  // unconfigured harness does, and the ONLY case that inherits.
  let model = opts.parentModel
  // The binding's OTHER field rides along: the runtime resolves and validates a
  // selection's `reasoningEffort`, so a spawn that kept only the client would
  // run the right model at the adapter default — the setting doing nothing,
  // invisibly. Absent stays absent (provider default).
  let reasoningEffort: ReasoningEffort | undefined
  // What the child ran on, RECORDED at spawn (Task 6) — the projection reads
  // this record instead of re-deriving the precedence, which it cannot do (the
  // settings getter is not on its source) and should not do (a running child's
  // settings can change under it). The inherit arm records nothing.
  let modelLabel: string | undefined
  if (declared !== undefined) {
    const state = await opts.resolveModel(declared)
    if (state.status !== "ready") {
      throw new Error(`role '${opts.role.name}' cannot resolve its model: ${state.reason}`)
    }
    model = state.binding.client
    reasoningEffort = state.binding.reasoningEffort
    modelLabel = modelLabelOf(declared)
  }

  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: childSession,
    tools: childReg,
    model,
    // M49 Task 14 (spec §11): role prompt + the subagent contract (scope/
    // delegation/changed-files+test reporting/result delivery). Human and
    // project instructions remain higher priority (the contract says so).
    systemPrompt: composeSubagentPrompt(opts.role.systemPrompt),
    signal: controller.signal,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    // M19 (Ruling 24): the child's durable session id is seeded onto every
    // prepared ToolExec so the agent-team scheduler can attribute the child's
    // tool calls to its team member (the roster maps sessionId → member).
    ...(sessionId !== undefined ? { sessionId } : {}),
    // M70: the child's own dispatch boundary gets the same checkpoint the
    // parent's does. MEASURED before wiring it: this child's appends are
    // mirrored into `opts.childSessions.coordinator` under THIS `sessionId`
    // (the createSession hook above), so `coordinator.flush(sessionId)` drains
    // the very write-behind that received the `tool/dispatch` marker — the same
    // closure shape the assembly builds for the parent, from the same pair.
    // Without `childSessions` there is no durable child session at all (the
    // non-durable `createSession()` arm above), so no seam is built and the
    // deps object is the pre-M70 one.
    ...(opts.childSessions !== undefined && sessionId !== undefined
      ? { flush: (): Promise<void> => opts.childSessions!.coordinator.flush(sessionId!) }
      : {}),
  })
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName)
  const initialRun = agent.run(opts.message, controller.signal)
  opts.table.add(childPath, {
    path: childPath,
    status: "running",
    // W11: the initial run starts HERE — one of the two sites that write
    // `status: "running"` and therefore one of the two that must stamp it (see
    // ChildAgentEntry.startedAt; the other is driveFollowups).
    startedAt: Date.now(),
    session: childSession,
    controller,
    mailbox: [],
    jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    roleName: opts.role.name,
    ...(modelLabel !== undefined ? { modelLabel } : {}),
    // Serialization: seed the followup chain with the initial run so a
    // followup_task fired mid-run waits for turn 1 to finish (dsh's
    // queue-then-run semantics) instead of running two runTurns concurrently
    // on the same session. The rejection is swallowed so a failed initial run
    // cannot reject the chain and silently kill all later followups.
    followupChain: initialRun.then(() => {}, () => {}),
    unmount: () => childCtx.scope.unmount(),
  })

  initialRun.then(
    (result) => {
      const e = opts.table.get(childPath)
      // The turn is done, but the child is KEPT alive (waiting) so a later
      // followup can re-drive the same agent (M9 spec §2.2). A stale error
      // from an earlier interrupted attempt is cleared on success.
      if (e) { e.status = "waiting"; e.error = undefined; e.finalText = result.finalText }
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
      opts.onSettled?.({ finalText: result.finalText, aborted: false })
    },
    (err) => {
      const aborted = controller.signal.aborted
      const e = opts.table.get(childPath)
      if (e) {
        // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
        e.status = "waiting"
        e.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
      }
      opts.jobs.updateJob(jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      opts.onSettled?.({ error: err instanceof Error ? err.message : String(err), aborted })
    },
  )

  return { path: childPath, jobId, sessionId }
}
