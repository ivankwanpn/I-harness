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

// Ruling 8 contract: the transact fn is PURE-READ — it only inspects the state
// and returns candidate events; it never mutates the state. The transact
// validates the candidates against a snapshot taken BEFORE the fn ran, then
// applies them to the live state and appends them to the log. A violation
// throws before anything reaches the log or the live state.
export function createTeamTransact(lead: TeamLead): TeamTransaction {
  let chain: Promise<unknown> = Promise.resolve()
  let state: TeamFoldState | undefined
  return {
    transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }): Promise<T> {
      const next = chain.then(async () => {
        if (!state) state = createFoldState()
        // Snapshot the pre-fn state; each candidate is validated against it so
        // the fold sees only events that existed when fn was called.
        const snapshot = structuredClone(state)
        const out = fn(state) // pure-read: may inspect state, must not mutate it
        if (out.events) {
          // Validate every candidate in order (zod + invariants). A violation
          // throws HERE, before any append — nothing commits.
          for (const e of out.events) applyTeamEvent(snapshot, e)
          // All candidates valid: apply to the live state, then append.
          for (const e of out.events) applyTeamEvent(state, e)
          for (const e of out.events) lead.append(e)
          await lead.flush()
          lead.onCommit?.(() => {})
        }
        return out.result
      })
      chain = next.catch(() => {}) // a throw commits nothing; chain survives
      return next
    },
  }
}
