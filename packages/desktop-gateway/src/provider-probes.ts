import type { ProviderRuntime } from "@i-harness/provider-runtime"

/** Explicit, cancellable read-only probes. The request token identifies one UI
 * attempt; restarting a probe cannot let a late cancellation stop its successor. */
export function createProviderProbes(runtime: Pick<ProviderRuntime, "probeModels"> & Partial<Pick<ProviderRuntime, "directory">>) {
  const active = new Map<string, AbortController>()
  const jobs = new Set<Promise<unknown>>()
  let closed = false
  return {
    async start(id: string, token: string) {
      if (closed || active.has(token) || active.size >= 4) throw new Error("Provider probe unavailable")
      const controller = new AbortController()
      active.set(token, controller)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      const job = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        const route = runtime.directory ? (await runtime.directory()).find((row) => row.id === id) : undefined
        signal.throwIfAborted()
        const modelProtocols = [...new Set(route?.models.map((model) => model.protocol).filter((protocol) => protocol !== undefined))]
        const protocol = route?.protocol ?? (modelProtocols.length === 1 ? modelProtocols[0] : undefined)
        if (route && protocol === undefined) throw new Error("先在模型設定中指定通訊協定，再探索模型；不同協議的模型列表可手動新增。")
        const models = await runtime.probeModels(id, { signal, ...(protocol ? { protocol } : {}) })
        signal.throwIfAborted()
        return models.map((model) => ({ ...model, ...(!model.protocol && protocol ? { protocol } : {}) }))
      })
      jobs.add(job)
      try { return await job }
      finally { active.delete(token); jobs.delete(job) }
    },
    cancel(token: string) { const job = active.get(token); job?.abort(); return { cancelled: job !== undefined } },
    async close() { closed = true; for (const controller of active.values()) controller.abort(); await Promise.allSettled(jobs) },
  }
}
