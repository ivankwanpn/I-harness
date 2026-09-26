import type { MemoryStore } from "@i-harness/memory"

export function memoryRequest(store: MemoryStore, method: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be an object")
  const params = raw as Record<string, unknown>
  switch (method) {
    case "desktop/memory/state": return { enabled: store.enabled(), generation: "unavailable", scope: "workspace" }
    case "desktop/memory/configure":
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be boolean")
      store.setEnabled(params.enabled)
      return { enabled: store.enabled() }
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
      return { note: store.add({ title: params.title, text: params.text }) }
    case "desktop/memory/forget":
      if (typeof params.id !== "string") throw new Error("id is required")
      return { forgotten: store.forget(params.id) }
    case "desktop/memory/summary": return { text: store.summary(), maxBytes: 6000 }
    default: throw new Error("unknown memory method")
  }
}
