import {assertOriginalManagedTeamCaller,assertOriginalTeamCallerProvisioning,type OriginalManagedTeamCaller} from '@i-harness/core-tools/internal/team-caller'
import type {OriginalTeamProvisioning} from '../../core-session/src/managed/team-provisioning.ts'
import { randomUUID } from "node:crypto"
import { AgentPath } from "./agent-path.ts"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamMemberSnapshot, type TeamMemberView } from "./types.ts"
import type { TeamFoldState } from "./fold.ts"
import type { TeamTransaction } from "./transact.ts"

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface RosterDeps {
  teamId: string
  managedDomain?:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain
  // shared live folded state (created via createFoldState / foldTeam); both the
  // roster's readers and the transact observe the same object.
  state: TeamFoldState
  transact: TeamTransaction
  // subagent integration (injected; internally spawns the durable child).
  // The 4th arg threads op-level spawn options to the bridge; the TEAM
  // scheduler derives the subagent forkTurns from context + opts.forkTurns
  // (M19 Ruling 27: fork_turns was previously dropped at this boundary).
  spawnChild: (name: string, prompt: string, context: "fresh" | "fork", opts?: { forkTurns?: "none" | "all" | number; managed?:{caller:OriginalManagedTeamCaller;provisioning:OriginalTeamProvisioning} }) => Promise<{ path: string; jobId: string; sessionId?: string }>
  recoverManaged?: (member:TeamMemberSnapshot)=>Promise<void>
  childSessionHoldsPrompt: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  interruptChild: (path: string) => Promise<string>
  closeChild: (path: string) => Promise<void>
  maxMembers?: number
  startupTimeoutMs?: number
  // live child status accessor (subagent table entry status by member id);
  // used to map active members: running->running, waiting->idle, else->inactive.
  memberStatus?: (id: string) => string
  /** The job belonging to this mounted child, if its runtime remains present. */
  memberJobId?: (id: string) => string | undefined
  // recovery probe: does the child session durably exist with the initial
  // prompt? Any failure (unknown session, lost log, truncated prompt) returns
  // false. Used by reconcileProvisioning (spec §4.1 step 6 / §8.3).
  childSessionIsDurable?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
}

// Ruling 10(c): every fn passed to deps.transact is PURE-READ — it inspects the
// state param (name reuse / maxMembers / phase guards) and returns
// { events, result }; it NEVER mutates the state. The transact runs the fn
// against a clone and validates candidates via applyTeamEvent before anything
// touches the live state or the log.
export function createRoster(deps: RosterDeps) {
  const maxMembers = deps.maxMembers ?? 8
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000

  function callerIsLead(caller: TeamCaller): boolean {
    return caller.role === "lead"
  }

  // runtime status mapping (no event written): the member's folded phase drives
  // provisioning/failed; an active member's live child status is authoritative.
  function liveStatus(id: string): TeamMemberView["status"] {
    const raw = deps.memberStatus?.(id)
    if (raw === "running") return "running"
    if (raw === "waiting" || raw === "idle") return "idle"
    return "inactive"
  }

  function memberView(m: TeamMemberSnapshot): TeamMemberView {
    const jobId = deps.memberJobId?.(m.id)
    return {
      id: m.id,
      name: m.name,
      role: "teammate" as const,
      status: m.phase === "provisioning" ? "provisioning" : m.phase === "failed" ? "failed" : liveStatus(m.id),
      description: m.description,
      context: m.context,
      diagnostics: [],
      agentPath: AgentPath.parse(`lead/${m.name}`).toString(),
      ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      ...(jobId ? { jobId } : {}),
    }
  }
  function listMembers(): TeamMemberView[] {
    const lead: TeamMemberView = { id: deps.teamId, name: "lead", role: "lead", status: "running", diagnostics: [] }
    const members = [...deps.state.members.values()].map(memberView)
    return [lead, ...members]
  }

  async function spawnTeammate(
    caller: TeamCaller,
    name: string,
    opts: { description: string; prompt: string; context?: "fresh" | "fork"; forkTurns?: "none" | "all" | number; originalCaller?:OriginalManagedTeamCaller },
  ): Promise<TeamMemberView> {
    if(opts.originalCaller){
      assertOriginalManagedTeamCaller(opts.originalCaller)
      const original=opts.originalCaller,args=original.call.args as {name?:unknown;description?:unknown;prompt?:unknown;context?:unknown;fork_turns?:unknown}
      if(!deps.managedDomain||original.context.domain!==deps.managedDomain||original.identity.parentSessionId!==deps.managedDomain.sessionId||args.name!==name||args.description!==opts.description||args.prompt!==opts.prompt||(args.context??'fresh')!==(opts.context??'fresh')||normalizeForkTurns(args.fork_turns as never)!==normalizeForkTurns(opts.forkTurns))throw TypeError('Original Team invocation changed')
    }else if(deps.managedDomain)throw TypeError('Original managed Team caller required')
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may spawn teammates")
    if (!NAME_RE.test(name) || name.length > 64 || name === "lead") throw new TeamError(TEAM_CODES.INVALID_MEMBER_NAME, `invalid teammate name "${name}"`)
    // fast fail; the serialized transact re-checks both atomically (authoritative)
    if (deps.state.members.size >= maxMembers) throw new TeamError(TEAM_CODES.MEMBER_LIMIT, `maxMembers ${maxMembers} reached`)

    const id = `child-${randomUUID()}`
    const provisioning: TeamMemberSnapshot = { id, name, description: opts.description, provider: "spawn", context: opts.context ?? "fresh", phase: "provisioning", ...opts.originalCaller?{sessionId:id}:{} }
    // Provisioning event: pure-read fn — name-taken and limit checks against the
    // snapshot; nothing is mutated here.
    const provision=(state:TeamFoldState) => {
      if (state.members.has(name)) throw new TeamError(TEAM_CODES.MEMBER_NAME_TAKEN, `member name "${name}" already taken`)
      if (state.members.size >= maxMembers) throw new TeamError(TEAM_CODES.MEMBER_LIMIT, `maxMembers ${maxMembers} reached`)
      return { events: [{ type: 'team/member' as const, version: 1 as const, teamId: deps.teamId, member: provisioning }], result: undefined }
    }
    let witness:OriginalTeamProvisioning|undefined
    if(opts.originalCaller){assertOriginalManagedTeamCaller(opts.originalCaller);if(!deps.transact.transactProvisioning)throw Error('Original Team provisioning unavailable');witness=(await deps.transact.transactProvisioning(provision,opts.originalCaller)).witness;assertOriginalManagedTeamCaller(opts.originalCaller);assertOriginalTeamCallerProvisioning(opts.originalCaller,witness)}else await deps.transact.transact(provision)

    // Spawn the durable child, then checkpoint that its session durably holds
    // the initial prompt within startupTimeoutMs.
    let spawned: { path: string; jobId: string; sessionId?: string } | undefined
    try {
      // M19 Ruling 27: thread fork_turns to the spawn bridge (it was dropped at
      // this boundary before). The tool forwards a plain string; normalize it
      // into the subagent SpawnOptions shape ("none"|"all"|N) so the bridge
      // receives forkTurns: N for fork_turns: "3".
      const forkTurns = normalizeForkTurns(opts.forkTurns)
      spawned = await deps.spawnChild(name, opts.prompt, provisioning.context, opts.originalCaller&&witness ? {...forkTurns!==undefined?{forkTurns}:{},managed:{caller:opts.originalCaller,provisioning:witness}} : forkTurns !== undefined ? { forkTurns } : undefined)
      if(opts.originalCaller&&spawned.sessionId!==id)throw Error('Original managed Team target changed')
      if (!spawned.sessionId) throw new Error(`child session id missing for "${name}" (durable child sessions required)`)
      const timeout = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), startupTimeoutMs)
        timer.unref()
      })
      const holds = await Promise.race([
        deps.childSessionHoldsPrompt(spawned.sessionId, new AbortController().signal),
        timeout,
      ])
      if (!holds) throw new Error("child session never durably held the initial prompt")
    } catch (e) {
      // A managed birth may have issued an UNKNOWN durable operation. Preserve
      // its original provisioning receipt and target for explicit recovery.
      if(opts.originalCaller)throw e
      // Failed event (best-effort; keeps the roster authoritative for recovery)
      // — pure-read fn again: the transition guard is applied by the transact's
      // applyTeamEvent validation. Persist the sessionId when the child was
      // created but the checkpoint failed, so recovery can still find it.
      const failed: TeamMemberSnapshot = { ...provisioning, phase: "failed", error: e instanceof Error ? e.message : String(e), sessionId: spawned?.sessionId }
      await deps.transact.transact((state) => {
        if (state.members.get(name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${name}" already reconciled`)
        return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: failed }], result: undefined }
      }).catch(() => {})
      try { await deps.closeChild(AgentPath.parse(`lead/${name}`).toString()) } catch { /* best-effort */ }
      throw e
    }

    // after the try completed without throw, spawned is defined (catch rethrows)
    const active: TeamMemberSnapshot = { ...provisioning, phase: "active", sessionId: spawned.sessionId }
    // Active event: pure-read fn; identity immutability + transition validity
    // are enforced by the transact's validation against the snapshot.
    await deps.transact.transact((state) => {
      if (state.members.get(name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${name}" already reconciled`)
      return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: active }], result: undefined }
    })
    return memberView(active)
  }

  // Recovery path (spec §4.1 step 6 / §8.3): a crash between the provisioning
  // append and the active/failed append leaves a member stuck in
  // "provisioning" forever (also counting against maxMembers). On mount/restore
  // the caller invokes this once: probes every provisioning member's child
  // session for durability — durable → provisioning→active, else →
  // provisioning→failed. All transitions go through the same pure-read transact
  // fns as spawnTeammate (the PROVISIONING_CONFLICT guards also make a
  // creator-vs-reconcile race lose cleanly: whoever settles the member first
  // wins; the other sees a non-provisioning phase and throws, which is
  // swallowed here as best-effort — the member is never double-settled).
  async function reconcileProvisioning(): Promise<void> {
    const pending = [...deps.state.members.values()].filter((m) => m.phase === "provisioning")
    // A snapshot miss cannot distinguish an unissued Team birth from a
    // reserved or UNKNOWN one. Keep the original target until the owned
    // binding/recovery operation can prove its disposition.
    if(deps.managedDomain){for(const m of pending){if(!deps.recoverManaged)throw Object.assign(Error('Original Team birth recovery required'),{code:'FACT_RECOVERY_REQUIRED'});await deps.recoverManaged(m);const active:TeamMemberSnapshot={...m,phase:'active'};await deps.transact.transact(state=>{if(state.members.get(m.name)?.phase!=='provisioning')throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT,`member "${m.name}" already reconciled`);return {events:[{type:'team/member' as const,version:1 as const,teamId:deps.teamId,member:active}],result:undefined}})}return}
    for (const m of pending) {
      const durable = deps.childSessionIsDurable
        ? await deps.childSessionIsDurable(m.sessionId ?? m.id, new AbortController().signal).catch(() => false)
        : false // no probe: cannot prove durability → fail closed (member without a live child must not go active)
      if (durable) {
        const active: TeamMemberSnapshot = { ...m, phase: "active" }
        await deps.transact.transact((state) => {
          if (state.members.get(m.name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${m.name}" already reconciled`)
          return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: active }], result: undefined }
        }).catch(() => {}) // creator settled it first (idempotent active→active) or a race lost: nothing to do
      } else {
        const failed: TeamMemberSnapshot = { ...m, phase: "failed", error: "reconciled: child not durable" }
        await deps.transact.transact((state) => {
          if (state.members.get(m.name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${m.name}" already reconciled`)
          return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: failed }], result: undefined }
        }).catch(() => {})
      }
    }
  }

  async function interrupt(caller: TeamCaller, target: string): Promise<{ previousStatus: string }> {
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may interrupt")
    if (target === "lead") throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, "cannot interrupt the lead")
    if (!deps.state.members.has(target)) throw new TeamError(TEAM_CODES.MEMBER_NOT_FOUND, `unknown teammate "${target}"`)
    // keepInbox semantics: delegation aborts the current turn but leaves the
    // child alive with its inbox intact; no roster event is written.
    return { previousStatus: await deps.interruptChild(AgentPath.parse(`lead/${target}`).toString()) }
  }

  function resolveCaller(id: string, name: string): TeamCaller {
    if (id === deps.teamId) return { id, name: "lead", role: "lead" }
    // M19 Ruling 24: the caller id may be the member's durable child SESSION id
    // (ToolExec.sessionId) rather than the roster-generated member id — map
    // both. Return the canonical ROSTER member id so the lead log records the
    // member identity (mailbox membership checks key on caller.name and the
    // self-message guard compares caller.id to the target's member id).
    const m = [...deps.state.members.values()].find((m) => m.id === id || m.sessionId === id)
    if (m) return { id: m.id, name: m.name, role: "teammate" }
    return { id, name, role: "teammate" }
  }

  return { listMembers, spawnTeammate, interrupt, resolveCaller, reconcileProvisioning }
}

// M19 Ruling 27: normalize the tool-level fork_turns value ("none" | "all" |
// "3" | 3 | undefined) into the subagent SpawnOptions shape. Undefined →
// undefined (the bridge applies its context default); anything else passes
// through as "none" | "all" | a positive integer, else undefined (fail-safe:
// an unparseable value falls back to the context default rather than spawning
// with garbage).
function normalizeForkTurns(value: "none" | "all" | number | string | undefined): "none" | "all" | number | undefined {
  if (value === undefined) return undefined
  if (value === "none" || value === "all") return value
  const n = typeof value === "number" ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
