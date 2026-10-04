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
    case "desktop/context-subsystems/state": return {}
    case "desktop/context-subsystems/configure": {
      if(!value.patch||typeof value.patch!=="object"||Array.isArray(value.patch)||Buffer.byteLength(JSON.stringify(value.patch))>65536)throw new Error("invalid context subsystem configuration")
      return {patch:value.patch}
    }
    case "desktop/context-subsystems/action": {
      if(!value.command||typeof value.command!=="object"||Array.isArray(value.command)||Buffer.byteLength(JSON.stringify(value.command))>4096)throw new Error("invalid context subsystem action")
      return {command:value.command}
    }
    case "desktop/code-mode/state": return value.sessionId === undefined ? {} : { sessionId: text("sessionId", 256) }
    case "desktop/code-mode/configure": {
      const patch = value.patch
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => key !== "mode") || !["off", "mixed", "only"].includes(String((patch as { mode?: unknown }).mode))) throw new Error("invalid Code Mode patch")
      return { patch, ...(value.sessionId === undefined ? {} : { sessionId: text("sessionId", 256) }) }
    }
    case "desktop/environment/diagnostics":
      if (value.probe !== undefined && typeof value.probe !== "boolean") throw new Error("invalid diagnostic probe flag")
      return { ...(value.sessionId === undefined ? {} : { sessionId: text("sessionId", 256) }), ...(value.probe === undefined ? {} : { probe: value.probe }) }
    case "desktop/session/execution/read": {
      if (value.offset !== undefined && (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0)) throw new Error("invalid execution offset")
      if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 20)) throw new Error("invalid execution limit")
      return { sessionId: text("sessionId", 256), ...(value.offset === undefined ? {} : { offset: value.offset }), ...(value.limit === undefined ? {} : { limit: value.limit }) }
    }
    case "desktop/session/execution/stop": return { sessionId: text("sessionId", 256), cellId: text("cellId", 256) }
    case "desktop/session/processes/read": return { sessionId: text("sessionId", 256) }
    case "desktop/session/processes/job-output": return { sessionId: text("sessionId", 256), id: text("id", 256) }
    case "desktop/session/processes/terminal-output": return { sessionId: text("sessionId", 256), id: text("id", 256) }
    case "desktop/session/processes/control": {
      if (!value.command || typeof value.command !== "object" || Array.isArray(value.command) || JSON.stringify(value.command).length > 131072) throw new Error("invalid process command")
      return { sessionId: text("sessionId", 256), command: value.command }
    }
    case "desktop/approval-rules/state": return {}
    case "desktop/approval-rules/revoke": return { ruleId: text("ruleId", 256) }
    case "desktop/approval-rules/add": {
      const remember = value.remember as { scope?: unknown; expiresAt?: unknown } | undefined
      if (!remember || !["session", "workspace"].includes(String(remember.scope)) || typeof remember.expiresAt !== "number" || !Number.isSafeInteger(remember.expiresAt) || remember.expiresAt <= Date.now() || remember.expiresAt > Date.now() + 366 * 86400000) throw new Error("invalid remembered approval expiry/scope")
      return { sessionId: text("sessionId", 256), requestId: text("requestId", 256), remember: { scope: remember.scope, expiresAt: remember.expiresAt } }
    }
    case "desktop/resources/list":
    case "desktop/resources/read": {
      if (value.resourceKind !== "skills" && value.resourceKind !== "commands") throw new Error("invalid resource kind")
      if (value.kind === "desktop/resources/read") {
        if (value.source !== undefined && !["workspace", "global", "plugin"].includes(String(value.source))) throw new Error("invalid resource source")
        return { resourceKind: value.resourceKind, name: text("name", 256), ...(value.source === undefined ? {} : { source: value.source }), ...(value.pluginId === undefined ? {} : { pluginId: text("pluginId", 256) }) }
      }
      if (typeof value.query !== "string" || value.query.length > 512 || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("invalid resource query")
      if (value.includeShadowed !== undefined && typeof value.includeShadowed !== "boolean") throw new Error("invalid resource layers flag")
      return { resourceKind: value.resourceKind, query: value.query, offset: value.offset, ...(value.includeShadowed === undefined ? {} : { includeShadowed: value.includeShadowed }) }
    }
    case "desktop/resources/write":
    case "desktop/resources/remove": {
      if (value.resourceKind !== "skills" && value.resourceKind !== "commands") throw new Error("invalid resource kind")
      if (value.source !== "workspace" && value.source !== "global") throw new Error("invalid resource source")
      const expectedRevision = value.expectedRevision
      if (expectedRevision !== null && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new Error("invalid resource revision")
      if (value.kind.endsWith("/remove") && (value.confirmed !== true || expectedRevision === null)) throw new Error("confirmed resource revision required")
      if (value.kind.endsWith("/write") && (typeof value.body !== "string" || Buffer.byteLength(value.body) > 262144)) throw new Error("invalid resource body")
      return { resourceKind: value.resourceKind, source: value.source, name: text("name", 64), expectedRevision, ...(value.kind.endsWith("/write") ? { body: value.body } : { confirmed: true }) }
    }
    case "desktop/hooks/read-config":
    case "desktop/hooks/write-config":
    case "desktop/hooks/read-script":
    case "desktop/hooks/write-script": {
      if (value.source !== "workspace" && value.source !== "global") throw new Error("invalid hook source")
      const writing = value.kind.includes("/write-")
      const script = value.kind.endsWith("-script")
      if (writing && (typeof value.body !== "string" || Buffer.byteLength(value.body) > 262144)) throw new Error("invalid hook body")
      if (writing && value.expectedRevision !== null && (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision))) throw new Error("invalid hook revision")
      return { source: value.source, ...(script ? { name: text("name", 64) } : {}), ...(writing ? { body: value.body, expectedRevision: value.expectedRevision } : {}) }
    }
    case "desktop/memory/update": {
      if (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) throw new Error("invalid memory revision")
      return { id: text("id", 256), title: text("title", 256), text: text("text", 16384), expectedRevision: value.expectedRevision }
    }
    case "desktop/memory/forget-many": {
      if (value.confirmed !== true || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 100) throw new Error("confirmed memory targets required")
      const targets = value.targets.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid memory target")
        const row = raw as Record<string, unknown>
        if (typeof row.id !== "string" || !row.id || row.id.length > 256 || typeof row.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedRevision)) throw new Error("invalid memory target")
        return { id: row.id, expectedRevision: row.expectedRevision }
      })
      return { confirmed: true, targets }
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
    case "desktop/session/subagents/list": return { sessionId: text("sessionId", 256) }
    case "desktop/session/subagents/history": {
      if (value.afterSeq !== undefined && (typeof value.afterSeq !== "number" || !Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0)) throw new Error("invalid afterSeq")
      if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 1000)) throw new Error("invalid history limit")
      return { sessionId: text("sessionId", 256), childSessionId: text("childSessionId", 256), ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq }), ...(value.limit === undefined ? {} : { limit: value.limit }) }
    }
    case "desktop/session/subagents/control": {
      if (!["followup", "message", "interrupt", "close"].includes(String(value.action))) throw new Error("invalid subagent action")
      return { sessionId: text("sessionId", 256), childSessionId: text("childSessionId", 256), action: value.action, ...(["followup", "message"].includes(String(value.action)) ? { text: text("text", 65536) } : {}) }
    }
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
