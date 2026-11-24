import { setTimeout as delay } from "node:timers/promises"
import { createMemoryTools, type MemoryStore } from "@i-harness/memory"

export type MemoryAuthoringRequest =
  | { kind: "desktop/memory/update"; workspaceId: string; id: string; title: string; text: string; expectedRevision: string }
  | { kind: "desktop/memory/forget-many"; workspaceId: string; confirmed: true; targets: { id: string; expectedRevision: string }[] }
export type MemoryAuthoringRequestHandler = (request: MemoryAuthoringRequest) => Promise<unknown>

export function memoryRequest(store: MemoryStore, method: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be an object")
  const params = raw as Record<string, unknown>
  switch (method) {
    case "desktop/memory/state": return { enabled: store.enabled(), generation: "unavailable", scope: "workspace" }
    case "desktop/memory/configure":
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be boolean")
      store.setEnabled(params.enabled)
      return { enabled: params.enabled }
    case "desktop/memory/list":
      if (params.limit !== undefined && typeof params.limit !== "number") throw new Error("invalid limit")
      return { notes: store.list(params.limit as number | undefined) }
    case "desktop/memory/search":
      if (typeof params.query !== "string" || (params.limit !== undefined && typeof params.limit !== "number")) throw new Error("invalid search")
      return { hits: store.search(params.query, params.limit as number | undefined) }
    case "desktop/memory/read":
      if (typeof params.id !== "string") throw new Error("id is required")
      return { note: store.read(params.id) }
    case "desktop/memory/note":
      if (typeof params.title !== "string" || typeof params.text !== "string") throw new Error("title and text required")
      if (!store.enabled()) throw new Error("memory is disabled")
      return { note: store.add({ title: params.title, text: params.text }, () => store.enabled()) }
    case "desktop/memory/update":
      if (typeof params.id !== "string" || typeof params.title !== "string" || typeof params.text !== "string" || typeof params.expectedRevision !== "string") throw new Error("id, title, text and expectedRevision required")
      return store.update({ id: params.id, title: params.title, text: params.text, expectedRevision: params.expectedRevision })
    case "desktop/memory/forget-many":
      if (params.confirmed !== true || !Array.isArray(params.targets) || !params.targets.every(row => row && typeof row === "object" && typeof row.id === "string" && typeof row.expectedRevision === "string")) throw new Error("confirmed targets required")
      return store.forgetMany(params.targets)
    case "desktop/memory/forget":
      if (typeof params.id !== "string") throw new Error("id is required")
      return { forgotten: store.forget(params.id) }
    case "desktop/memory/summary": return { text: store.summary(), maxBytes: 6000 }
    default: throw new Error("unknown memory method")
  }
}

// Each attempt has at most one mutation. SQLite BUSY leaves an autocommit
// statement uncommitted; MemoryStore rolls back an explicit transaction
// before propagating BUSY. Other errors, including failed rollback, escape.
export function createDesktopMemory(store: MemoryStore, shared: boolean) {
  const lifetime = new AbortController()
  let configuration = new AbortController()
  let enabledActions = new AbortController()
  let disabling = false
  async function run<T>(action: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    const deadline = performance.now() + 5000
    let interval = 16
    for (;;) {
      signal.throwIfAborted()
      try { return await action() }
      catch (error) {
        const failure = error as { code?: string; errcode?: number } | null
        const remaining = deadline - performance.now()
        if (!shared || failure?.code !== "ERR_SQLITE_ERROR" || ((failure.errcode ?? 0) & 255) !== 5 || remaining <= 0) throw error
        await delay(Math.min(interval, remaining), undefined, { signal })
        signal.throwIfAborted()
        if (performance.now() >= deadline) throw error
        interval = Math.min(100, interval * 2)
      }
    }
  }
  function editSignal(toolSignal?: AbortSignal) {
    if (disabling) throw new Error("Memory is being disabled")
    return AbortSignal.any(toolSignal ? [lifetime.signal, enabledActions.signal, toolSignal] : [lifetime.signal, enabledActions.signal])
  }
  return {
    stop() { lifetime.abort(new Error("Workspace memory is closing")) },
    tools: createMemoryTools(store, () => store.enabled()).map(tool => ({
      ...tool,
      execute: async (args: Parameters<typeof tool.execute>[0], exec: Parameters<typeof tool.execute>[1]) =>
        run(() => tool.execute(args, exec), editSignal(exec.abortSignal)),
    })),
    async request(method: string, params: unknown) {
      const action = () => memoryRequest(store, method, params)
      const enabled = (params as { enabled?: unknown } | null)?.enabled
      if (method === "desktop/memory/configure" && typeof enabled === "boolean") {
        configuration.abort(new Error("Workspace memory configuration changed"))
        const policy = configuration = new AbortController()
        disabling = !enabled
        if (disabling) {
          enabledActions.abort(new Error("Workspace memory is being disabled"))
          enabledActions = new AbortController()
        }
        try { return await run(action, AbortSignal.any([lifetime.signal, policy.signal])) }
        finally { if (configuration === policy) disabling = false }
      }
      return run(action, method === "desktop/memory/note" ? editSignal() : lifetime.signal)
    },
  }
}
