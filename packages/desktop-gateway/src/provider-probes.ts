import type { ProviderRuntime } from "@i-harness/provider-runtime"

/** Explicit, cancellable read-only probes. The request token identifies one UI
 * attempt; restarting a probe cannot let a late cancellation stop its successor. */
export function createProviderProbes(runtime: Pick<ProviderRuntime, "probeModels">) {
  const active = new Map<string, AbortController>()
  const jobs = new Set<Promise<unknown>>()
  let closed = false
  return {
    async start(id: string, token: string) {
      if (closed || active.has(token) || active.size >= 4) throw new Error("Provider probe unavailable")
      const controller = new AbortController()
      active.set(token, controller)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      const job = Promise.resolve().then(() => { signal.throwIfAborted(); return runtime.probeModels(id, { signal }) })
      jobs.add(job)
      try { return await job }
      finally { active.delete(token); jobs.delete(job) }
    },
    cancel(token: string) { const job = active.get(token); job?.abort(); return { cancelled: job !== undefined } },
    async close() { closed = true; for (const controller of active.values()) controller.abort(); await Promise.allSettled(jobs) },
  }
}
