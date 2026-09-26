/** Strict allowlist for context/memory IPC. No filesystem or backend logic. */
export function contextRequestParams(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = (field: string, max: number) => {
    const raw = value[field]
    if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > max) throw new Error("invalid " + field)
    return raw
  }
  const limit = () => {
    if (value.limit === undefined) return {}
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100) throw new Error("invalid limit")
    return { limit: value.limit }
  }
  switch (value.kind) {
    case "desktop/session/search":
      return { query: text("query", 4096), ...limit(), ...(value.sessionId === undefined ? {} : { sessionId: text("sessionId", 256) }) }
    case "desktop/session/compact":
      return { sessionId: text("sessionId", 256), ...(value.instructions === undefined ? {} : { instructions: text("instructions", 4096) }) }
    case "desktop/memory/state":
    case "desktop/memory/summary": return {}
    case "desktop/memory/configure":
      if (typeof value.enabled !== "boolean") throw new Error("invalid enabled")
      return { enabled: value.enabled }
    case "desktop/memory/list": return limit()
    case "desktop/memory/search": return { query: text("query", 1024), ...limit() }
    case "desktop/memory/read":
    case "desktop/memory/forget": return { id: text("id", 256) }
    case "desktop/memory/note": return { title: text("title", 256), text: text("text", 16384) }
    default: return undefined
  }
}
