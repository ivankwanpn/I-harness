import { AsyncLocalStorage } from "node:async_hooks"

/** Shared by input admission, runtime starts and structural management. Holding
 * this fence drains already admitted producers and refuses new ones. */
export function createSessionManagementFence() {
  const blocked = new Set<string>()
  const retired = new Set<string>()
  const work = new Map<string, Set<Promise<unknown>>>()
  const admitted = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
  function assertOpen(id: string) {
    if (blocked.has(id) || retired.has(id)) throw new Error("Session management is in progress or session is deleted")
  }
  return {
    assertOpen,
    retire(id: string) { retired.add(id) },
    async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
      // Already registered producers may finish their nested service calls
      // while management drains them. No new outer admission gets this grant.
      if (!admitted.getStore()?.get(id)?.active || retired.has(id)) assertOpen(id)
      // Registration precedes the operation's first await.
      const token = { active: true }
      const context = new Map(admitted.getStore()); context.set(id, token)
      const pending = Promise.resolve().then(() => admitted.run(context, operation))
      let jobs = work.get(id)
      if (!jobs) { jobs = new Set(); work.set(id, jobs) }
      jobs.add(pending)
      try { return await pending } finally { token.active = false; jobs.delete(pending); if (!jobs.size) work.delete(id) }
    },
    async exclusive<T>(id: string, operation: () => Promise<T>, preflight?: () => Promise<void>): Promise<T> {
      assertOpen(id); blocked.add(id)
      try {
        // Refuse live turns/approval waits immediately before draining short
        // admitted writers. The blocked flag closes the check/admission race.
        await preflight?.()
        // An admitted operation may schedule a separately drained child before
        // it settles. Keep draining until no registered producer remains.
        while (work.get(id)?.size) {
          await preflight?.()
          await Promise.allSettled([...(work.get(id) ?? [])])
        }
        return await operation()
      }
      finally { blocked.delete(id) }
    },
  }
}
export type SessionManagementFence = ReturnType<typeof createSessionManagementFence>
