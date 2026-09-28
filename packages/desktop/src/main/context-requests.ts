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
    case "desktop/resources/list":
    case "desktop/resources/read": {
      if (value.resourceKind !== "skills" && value.resourceKind !== "commands") throw new Error("invalid resource kind")
      if (value.kind === "desktop/resources/read") return { resourceKind: value.resourceKind, name: text("name", 256) }
      if (typeof value.query !== "string" || value.query.length > 512 || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("invalid resource query")
      return { resourceKind: value.resourceKind, query: value.query, offset: value.offset }
    }
    case "desktop/mcp/state":
    case "desktop/mcp/refresh": return {}
    case "desktop/mcp/mutate": {
      if (!value.command || typeof value.command !== "object" || Array.isArray(value.command)) throw new Error("invalid MCP command")
      const command = value.command as Record<string, unknown>
      if (!["save", "enable", "disable", "remove"].includes(String(command.action))) throw new Error("invalid MCP action")
      return { ...command }
    }
    case "desktop/hooks/state":
    case "desktop/hooks/refresh": return {}
    case "desktop/hooks/mutate": {
      if (!value.command || typeof value.command !== "object" || Array.isArray(value.command)) throw new Error("invalid hook command")
      const command = value.command as Record<string, unknown>
      if (!["approve", "revoke"].includes(String(command.action)) || typeof command.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(command.sha256)) throw new Error("invalid hook command")
      if (command.action === "approve" && (typeof command.id !== "string" || !/^[a-f0-9]{64}$/.test(command.id))) throw new Error("invalid hook identity")
      return { ...command }
    }
    case "desktop/subagents/state": return {}
    case "desktop/subagents/mutate": {
      if (!value.command || typeof value.command !== "object" || Array.isArray(value.command)) throw new Error("invalid subagent settings command")
      const command = value.command as Record<string, unknown>
      if (!["enable", "role/set", "role/clear"].includes(String(command.action))) throw new Error("invalid subagent settings action")
      return { ...command }
    }
    case "desktop/agent-settings/state": return {}
    case "desktop/agent-settings/configure": {
      if (!value.patch || typeof value.patch !== "object" || Array.isArray(value.patch)) throw new Error("invalid agent settings patch")
      const patch = value.patch as Record<string, unknown>
      if (Object.keys(patch).some((key) => !["sandboxMode", "autoCompaction", "approvalMode"].includes(key))) throw new Error("unknown agent setting")
      if (patch.sandboxMode !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(String(patch.sandboxMode))) throw new Error("invalid sandbox mode")
      if (patch.autoCompaction !== undefined && typeof patch.autoCompaction !== "boolean") throw new Error("invalid auto compaction")
      if (patch.approvalMode !== undefined && !["dangerous", "ask-all", "delegate", "full-access"].includes(String(patch.approvalMode))) throw new Error("invalid approval mode")
      return { ...patch }
    }
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
