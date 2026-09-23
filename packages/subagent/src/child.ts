import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry, type ToolRegistry } from "@i-harness/core-tools"
import { createAgent, type AgentRegistry, type ReasoningEffort } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
// M73: the char/token constant the overhead estimate below is priced against —
// the same one the session's own assembly prices its twin by. M76 takes
// `estimateContent` from the same meter: the seed's own projection is priced
// with the meter the child's engine prices its surface with, one rule and one
// unit for both sides of the comparison.
import { CHARS_PER_TOKEN, estimateContent } from "@i-harness/token-meter"
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
 * M73 (ruling M73-P1): the child's prompt-and-schemas overhead, priced the way
 * the session's own assembly prices the same pair (`estimateAssemblyOverhead`,
 * assembly.ts): the charge the child's log never carries but the model sees on
 * every request. ONE definition because BOTH arms of the budget chain need it —
 * `spawnChild` below charges it so the child's request is clamped against a
 * realistic input, and the rebuilt child (`tools.ts`'s `ensureResidentAgent`)
 * imports it so a resumed child does not silently lose the charge the first one
 * had. Two copies of one rule are two places to drift.
 *
 * Module-local by ruling: it is exported for its sibling module in this
 * package, NOT through the package entry (`index.ts` names its exports and does
 * not re-export this one).
 */
export function estimateChildOverhead(systemPrompt: string, schemas: unknown): number {
  return Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) + Math.ceil(JSON.stringify(schemas).length / CHARS_PER_TOKEN)
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
  /** M73: the SESSION's own model's numbers — what an INHERITING child runs
   * under (no declared role model). They ride this host shape for the same
   * reason `roleSelectionFor` does: every spawn arm (the subagent tool, the
   * team scheduler, the guardian) already carries it, so the values reach
   * `spawnChild` without a second parameter path. NOT the numbers of a role's
   * DECLARED model — that binding resolves at spawn and carries its own
   * (RoleModelState's ready arm below). Absent → no key is written. */
  contextWindow?: number
  maxOutputTokens?: number
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
 * reason session-executor declares its own binding result type.
 *
 * M73 widened the ready arm with the binding's `contextWindow`/`maxOutputTokens`
 * (provider-runtime already emits them — `resolveModel`'s ready arm spreads
 * both when they resolve). They were REACHING this spawn at runtime and being
 * dropped HERE, by the type and the one read site: an undeclared field cannot
 * be read without a cast, so the child kept the client and silently ran
 * unbounded. Absent stays absent — both are optional and neither is defaulted. */
export type RoleModelState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: { client: ModelClient; reasoningEffort?: ReasoningEffort; contextWindow?: number; maxOutputTokens?: number } }

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
  // The model is decided, gated AND RESOLVED before anything is created: both
  // refusals — the gate here, the resolver in the block below — sit above every
  // durable write, so a refused spawn leaves no child session, no table entry
  // and no job behind.
  //
  // M76: the resolver used to be the LAST step, after `coordinator.create` had
  // already written the durable `child-<uuid>` session and the seed had been
  // pasted into it. A binding that was not ready therefore threw with an orphan
  // log left behind — seeded, ownerless, and with no dispose path anywhere in
  // this file. The sentence above was true only of the gate.
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

  // model: the declared selection (settings first, then the role's own) through
  // the host's resolver, else inherit the parent's client — which is what an
  // unconfigured harness does, and the ONLY case that inherits.
  //
  // M76 (design §1.2): this block sits HERE, between the gate above and the
  // first durable write below, because it is the second thing that can refuse a
  // spawn. A binding that does not resolve throws before `coordinator.create`
  // exists to be called, so nothing durable is minted for it; resolving first
  // also puts the window and the cap in scope before the seed is built, which
  // is what lets the seed's own price be measured against them (below).
  let model = opts.parentModel
  // The binding's OTHER field rides along: the runtime resolves and validates a
  // selection's `reasoningEffort`, so a spawn that kept only the client would
  // run the right model at the adapter default — the setting doing nothing,
  // invisibly. Absent stays absent (provider default).
  let reasoningEffort: ReasoningEffort | undefined
  // M73: the numbers the request is CLAMPED against and the ladder MEASURES
  // with. The declared arm reads them off the binding it just resolved; the
  // inherit arm takes the session's, handed in on the host shape.
  let contextWindow = opts.contextWindow
  let maxOutputTokens = opts.maxOutputTokens
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
    contextWindow = state.binding.contextWindow
    maxOutputTokens = state.binding.maxOutputTokens
    modelLabel = modelLabelOf(declared)
  }

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

  // M76 (design §1.3): a seed that already fills the window is VISIBLE, and
  // that is all this is. The seed is not trimmed and a spawn is not refused for
  // being oversized, both by ruling, not by omission: a divisible over-window
  // seed is exactly what the child's own compactor summarises (M75's chained
  // pieces), so trimming would silently discard what a summary keeps — strictly
  // worse, and invisible to the child and to the user alike — while refusing
  // would close the feature's primary use case, a child spawned FROM a large
  // session. What the reader cannot see today is the WASTE and the RISK: the
  // child's first request cannot be built without a summarising pass, and an
  // inherited context that is one indivisible block makes that pass fail soft.
  // After that the ladder's reset is the whole rescue — it drops the context,
  // and only when the log has events beyond the retained tail: with nothing
  // removable it returns `reset: false` (`compaction/src/index.ts:361`) and the
  // ladder fails closed instead. The M74 strict case's six tail turns are that
  // condition (its measured outcome); design §4.4's residual — the indivisible
  // block the chunker cannot split, whose real fix is a cap at the block's
  // SOURCE — is the half this warn can only make visible.
  //
  // The condition is measured, not guessed: `childSession` holds nothing but
  // the seed here (the agent does not exist yet), so this is the seed's own
  // projection priced with `estimateContent(deriveMessages(...))` — the meter's
  // own `activeTokens` expression, the one the engine prices with too. No
  // window → nothing to compare → no line (absent stays absent, the M73 rule
  // above).
  //
  // The BOUNDARY is deliberately NOT the engine's, and the difference is the
  // point. The child's compactor fires at the pressure gate
  // `activeTokens + overheadTokens >= window × thresholdRatio` — 0.8 by default
  // (`compaction/src/index.ts:230`, `compaction/src/config.ts:106`; the child
  // never overrides it — no `thresholdRatio` is passed anywhere in this
  // package) — and the hard budget is `window × reserveRatio` = 0.9
  // (`token-meter/src/budget.ts:14`). This line compares the seed's own
  // projection against the FULL window, so it is strictly NARROWER than either:
  // the band `[0.8·window − overhead, window)` is silent here — a known,
  // deliberate narrowing, not an oversight. MOST of that band is the healthy
  // case: the summariser's single request still fits the window (roughly
  // `seed + directive + overhead < window` — with the M75 case's measured
  // 449-token directive and this role's 256-token overhead, the seed has to
  // stay under `window − 705`). The band's TOP SLIVER does not fit — the
  // summariser's own request is over the window there, which is what M75's
  // chained pieces are for — and at small windows the WHOLE band is at or above
  // that fit bound, because the band's floor `0.8·window − overhead` overtakes
  // the fit bound `window − directive − overhead` below `window = 5 × directive`
  // (the overhead cancels; at this file's 2 000-token test window it is 1 344
  // against 1 295). None of that moves the line, whose subject is the HARD
  // bound — the seed ALONE crossing the window, where the piece path becomes
  // necessary and where an indivisible seed has nothing left but the reset
  // (with a tail beyond it — the M74 strict case) or the fail-closed throw
  // (without one — this file's own warn fixture).
  if (contextWindow !== undefined) {
    const seedTokens = estimateContent(deriveMessages(childSession))
    if (seedTokens >= contextWindow) {
      d.warn(
        `[subagent] the inherited seed prices at ${seedTokens} tokens against a ${contextWindow}-token window: ` +
          `the child summarises its inherited context in pieces before its first request, and if that context ` +
          `is one indivisible block the summariser fails soft — the reset then rescues the turn by dropping it ` +
          `when the log has events beyond the retained tail, and the turn fails closed when it does not`,
      )
    }
  }

  // child registry: register the role's allowed tools (resolved from the parent).
  // A declared tool the host does not mount is reported, never dropped silently.
  const childReg = createToolRegistry(childCtx)
  resolveRoleTools(opts.role.name, opts.role.tools, opts.parentRegistry, childReg)

  // M73: the prompt is composed ONCE — the agent gets it, and the overhead
  // estimate below prices it.
  const childPrompt = composeSubagentPrompt(opts.role.systemPrompt)
  // The charge the child's log never carries but the model sees on every
  // request: its composed prompt and its tool schemas' JSON — priced the way the
  // session's own assembly prices the same pair (assembly.ts's
  // estimateAssemblyOverhead), against the char/token constant token-meter owns.
  // Absent window → absent overhead: `budget` needs a window anyway.
  const overheadTokens = contextWindow === undefined
    ? undefined
    : estimateChildOverhead(childPrompt, childReg.schemas())

  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: childSession,
    tools: childReg,
    model,
    // M49 Task 14 (spec §11): role prompt + the subagent contract (scope/
    // delegation/changed-files+test reporting/result delivery). Human and
    // project instructions remain higher priority (the contract says so).
    systemPrompt: childPrompt,
    signal: controller.signal,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    // M73: the budget this child's requests carry. Before this, a child ran
    // unbounded — no cap (per-provider max_tokens absent, so on anthropic the
    // adapter's own unclamped fallback went to the wire) and no window (the
    // budget ladder cannot even fire without one). Both come from the same
    // place the main session's do.
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    // M73: the window the child's budget ladder measures with (the cap above is
    // what the request carries; this is what it is clamped against). Before it,
    // a windowless child sent the over-window request and let the provider
    // answer it — a 400 the harness could not see coming. The ladder's LAST
    // layer is still reachable (compaction + reset can both fail to bring the
    // surface back), and it still fails closed: pinned by "a child past its
    // window FAILS CLOSED" in test/child.test.ts.
    ...(contextWindow !== undefined
      ? { budget: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
    // M74: the child's OWN compactor. Without it the ladder's first two layers
    // are unreachable (core-agent builds one only from `compact`) and a child
    // past `window * 0.9` has exactly one layer left — the fail-closed throw.
    // With it, the pass shadows the region and the turn continues; the 10%
    // between the pressure gate (0.8) and the budget (0.9) is its head start.
    // `requestShape` needs no wiring here: core-agent builds it from THIS
    // child's systemPrompt and tools, so the summarizer's call is a byte-prefix
    // of the child's own request (the provider cache serves it). `auto` is not
    // written — it already defaults true, and a knob that can only be turned off
    // would be a surface a child has no handle to use (`Agent.compact` is
    // reachable only through a SessionAssembly).
    // M74 (final review) / M75: when the child's surface exceeds the window,
    // the summarizer's single request — the whole inherited surface plus the
    // directive, prompt and schemas, with `clampOutputCap` returning the raw cap
    // exactly when the input already fills the window — is one a strict
    // provider rejects. M75 answers that with CHAINED PIECES: whenever the
    // request cannot fit and the region can be sliced (the gate wants all four
    // — a region, a request shape, a resolved cap, a window — and a child
    // supplies each: the engine's own compact pass names the region, core-agent
    // builds the shape, the role binding resolves the numbers), the summarizer
    // summarises the region piece by piece and the child keeps its inherited
    // context as a SUMMARY. What remains of the old regime is the
    // region NO piece can fit — one indivisible block (design §4.4) — where the
    // pass still fails soft and the ladder's reset still rescues the turn with
    // the inherited context DROPPED. Pinned by "on a strict provider the child
    // still completes" (the indivisible fixture) and "an over-window child
    // region that CAN be split is summarised" (the divisible one) in
    // test/child.test.ts.
    ...(contextWindow !== undefined
      ? { compact: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
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
