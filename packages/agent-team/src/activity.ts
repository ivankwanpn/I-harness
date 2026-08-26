// Edge-triggered activity wait for the Team scope (M19 Task 8).
//
// Semantics:
//   - waitForChange registers a waiter; ONLY a subsequent notify() (post-
//     registration) wakes it — changes that already happened do not replay.
//   - timeout is validated strictly against [waitMinMs, waitMaxMs]; anything
//     else (including non-safe-integers) throws TEAM_INVALID_TIMEOUT.
//   - close() releases every waiter with { timedOut: false } and makes later
//     waits return immediately; notify()/close() are exported for the
//     commit/dispose paths (transact/mount/thaw).
//   - abort resolves the waiter with { timedOut: false }.
//   - noProgress is domain-level: when hasActivePeer() reports no other active
//     or provisioning member, the wait short-circuits immediately with
//     { timedOut: false, noProgress: { reason: "no-active-peer" } }.
import { TeamError, TEAM_CODES, type TeamCaller } from "./types.ts"

export interface ActivityConfig {
  waitMinMs: number
  waitMaxMs: number
  waitDefaultMs: number
}

export interface TeamWaitResult {
  timedOut: boolean
  noProgress?: { reason: "no-active-peer"; message: string }
}

export function createActivity(cfg: ActivityConfig) {
  let closed = false
  const waiters = new Set<(v: TeamWaitResult) => void>()

  function notify(): void {
    for (const w of [...waiters]) {
      waiters.delete(w)
      w({ timedOut: false })
    }
  }

  function close(): void {
    closed = true
    notify()
  }

  async function waitForChange(
    caller: TeamCaller,
    timeoutMs?: number,
    signal?: AbortSignal,
    hasActivePeer?: () => boolean,
  ): Promise<TeamWaitResult> {
    void caller
    const t = timeoutMs ?? cfg.waitDefaultMs
    if (!Number.isSafeInteger(t) || t < cfg.waitMinMs || t > cfg.waitMaxMs) {
      throw new TeamError(TEAM_CODES.INVALID_TIMEOUT, `timeout must be ${cfg.waitMinMs}-${cfg.waitMaxMs} ms`)
    }
    if (closed) return { timedOut: false }
    // Domain-level noProgress shortcut: no other active member → immediate.
    if (hasActivePeer && !hasActivePeer()) {
      return {
        timedOut: false,
        noProgress: {
          reason: "no-active-peer",
          message: "No other Team member is running or provisioning. Re-list with list_members, use followup_task to wake an inactive teammate, then wait again.",
        },
      }
    }
    return await new Promise<TeamWaitResult>((resolve) => {
      let settled = false
      const finish = (v: TeamWaitResult) => {
        if (settled) return
        settled = true
        waiters.delete(fn)
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => finish({ timedOut: true }), t)
      const fn = (v: TeamWaitResult) => finish(v)
      waiters.add(fn)
      if (signal) signal.addEventListener("abort", () => finish({ timedOut: false }), { once: true })
    })
  }

  return { waitForChange, notify, close }
}
