import type { TeamEvent } from "./types.ts"
import { applyTeamEvent, createFoldState, type TeamFoldState } from "./fold.ts"

export interface TeamLead {
  append(event: TeamEvent): void
  flush(): Promise<void>
  onCommit?(fn: () => void): void
}
export interface TeamTransaction {
  transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }): Promise<T>
}

// Manual clone: applyTeamEvent mutates the queued arrays in place (push), so
// they must be deep-copied; member/task objects are replaced wholesale, never
// mutated in place. Cheap insurance vs structuredClone if state ever holds
// class instances.
function cloneState(state: TeamFoldState): TeamFoldState {
  return {
    members: new Map(state.members),
    tasks: new Map(state.tasks),
    queued: new Map([...state.queued].map(([k, list]) => [k, [...list]])),
    delivered: new Set(state.delivered),
    nextTaskNumber: state.nextTaskNumber,
  }
}

// Ruling 10 contract: the transact fn is PURE-READ — it inspects the state
// param and returns { events, result }; it NEVER mutates the state. The
// transact runs the fn against a CLONE, validates each candidate in order via
// applyTeamEvent against that clone, then applies the validated events to the
// live state, appends them to the log, and flushes. A misbehaving fn can only
// corrupt the throwaway clone — "invalid never enters state or log" holds by
// construction.
//
// `state` is optional and SHARED: pass the team's live folded state so external
// readers (listMembers/getTask/pendingCount) and the transact observe the same
// object; on restore the caller seeds it via foldTeam so replay validation sees
// prior events (no double-apply of a duplicate provisioning on restart).
export function createTeamTransact(lead: TeamLead, state?: TeamFoldState): TeamTransaction {
  let chain: Promise<unknown> = Promise.resolve()
  let shared: TeamFoldState | undefined = state
  return {
    transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }): Promise<T> {
      const next = chain.then(async () => {
        if (!shared) shared = createFoldState()
        // fn runs against the throwaway clone, never the live state.
        const snapshot = cloneState(shared)
        const out = fn(snapshot)
        if (out.events && out.events.length > 0) {
          // Validate every candidate in order (zod + invariants) against the
          // snapshot, which accumulates the candidates as they validate (so
          // [provisioning, active] chains correctly). A violation throws HERE,
          // before anything reaches the live state or the log.
          for (const e of out.events) applyTeamEvent(snapshot, e)
          // All candidates valid: apply to the live state, then append.
          for (const e of out.events) applyTeamEvent(shared, e)
          for (const e of out.events) lead.append(e)
          // AT-LEAST-ONCE: events are applied + appended BEFORE flush. If
          // flush rejects, the caller rejects but state/log retain the applied
          // events; recovery replays the log, so nothing is lost — callers
          // must treat the outcome as committed once append succeeded.
          await lead.flush()
          lead.onCommit?.(() => {})
        }
        return out.result
      })
      chain = next.catch(() => {}) // a throw commits nothing new; chain survives
      return next
    },
  }
}
