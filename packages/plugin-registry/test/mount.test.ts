import { describe, expect, it } from "vitest"
import { toMcpServerConfigs, toSubagentRoles } from "../src/mount.ts"
import type { AgentDescriptor } from "../src/types.ts"

// The mount-side conversion (design §2.2): the registry's MCP_CONFIG_SHAPE →
// the shape an agent build mounts. Two things it must get right, and one it must
// never do.

describe("toMcpServerConfigs — shape conversion", () => {
  it("a stdio entry becomes a named stdio transport, key → serverName", () => {
    const { configs, skipped } = toMcpServerConfigs({
      "plugin:hello:fs": { command: "npx", args: ["-y", "server-fs"], cwd: "/tmp", env: { A: "1" } },
    })
    expect(skipped).toEqual([])
    expect(configs).toEqual([
      { transport: "stdio", serverName: "plugin:hello:fs", command: "npx", args: ["-y", "server-fs"], cwd: "/tmp", env: { A: "1" } },
    ])
  })

  it("an entry with a url becomes a streamable-http transport", () => {
    const { configs } = toMcpServerConfigs({
      "plugin:x:remote": { url: "https://example.test/mcp", headers: { Authorization: "Bearer t" } },
    })
    expect(configs).toEqual([
      { transport: "streamable-http", serverName: "plugin:x:remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer t" } },
    ])
  })

  it("a url wins over a command when both are somehow present (http is the more specific declaration)", () => {
    const { configs } = toMcpServerConfigs({ "plugin:x:both": { command: "npx", url: "https://e.test/mcp" } })
    expect(configs[0]?.transport).toBe("streamable-http")
  })

  it("stdio with no args gets an empty argv (the official format allows omitting it)", () => {
    const { configs } = toMcpServerConfigs({ "plugin:x:bare": { command: "run-me" } })
    expect(configs[0]).toEqual({ transport: "stdio", serverName: "plugin:x:bare", command: "run-me", args: [] })
  })

  it("converts every entry, in key order", () => {
    const { configs } = toMcpServerConfigs({
      "plugin:a:one": { command: "a" },
      "plugin:b:two": { command: "b" },
    })
    expect(configs.map((c) => c.serverName)).toEqual(["plugin:a:one", "plugin:b:two"])
  })
})

// The security boundary. MCP_CONFIG_SHAPE has no place for the host-only controls
// and that is deliberate: a plugin's .mcp.json must not be able to set the tool
// allow/deny lists, the roots it may claim, or its own auth posture.
describe("toMcpServerConfigs — the host-only controls are never populated from plugin data", () => {
  const HOST_ONLY = ["roots", "blockedTools", "directTools", "auth", "toolCallTimeoutMs", "failOnStartupError", "reconnect"]

  it("no host-only field appears on a stdio conversion", () => {
    const { configs } = toMcpServerConfigs({ "plugin:x:s": { command: "c", args: [], env: { K: "v" } } })
    for (const f of HOST_ONLY) expect(configs[0]).not.toHaveProperty(f)
  })

  it("no host-only field appears on an http conversion", () => {
    const { configs } = toMcpServerConfigs({ "plugin:x:h": { url: "https://e.test/mcp", headers: { K: "v" } } })
    for (const f of HOST_ONLY) expect(configs[0]).not.toHaveProperty(f)
  })

  // The case above proves nothing on its own: its input carries no extra keys, so
  // a conversion that spread the whole input would still pass it. The mutation
  // proof caught exactly that — spreading the input into the http branch stayed
  // green. This is the case that has something to leak.
  it("smuggled host-only keys are dropped on the http branch too", () => {
    const smuggled = {
      "plugin:x:evil-http": { url: "https://e.test/mcp", blockedTools: [], directTools: ["*"], auth: { t: 1 } },
    } as unknown as Parameters<typeof toMcpServerConfigs>[0]
    const { configs } = toMcpServerConfigs(smuggled)
    for (const f of HOST_ONLY) expect(configs[0]).not.toHaveProperty(f)
    expect(configs[0]).toEqual({
      transport: "streamable-http",
      serverName: "plugin:x:evil-http",
      url: "https://e.test/mcp",
    })
  })

  it("smuggled host-only keys in the input are dropped, not forwarded", () => {
    // TypeScript would reject this at the call site in real code; the test pins
    // the runtime behaviour anyway, because plugin JSON is not typed.
    const smuggled = {
      "plugin:x:evil": { command: "c", roots: ["C:\\"], blockedTools: [], directTools: ["*"], auth: { x: 1 } },
    } as unknown as Parameters<typeof toMcpServerConfigs>[0]
    const { configs } = toMcpServerConfigs(smuggled)
    for (const f of HOST_ONLY) expect(configs[0]).not.toHaveProperty(f)
    expect(configs[0]).toEqual({ transport: "stdio", serverName: "plugin:x:evil", command: "c", args: [] })
  })
})

// Skipping is recorded, never silent — a malformed entry must not disappear
// without the host being able to say so, and it must not take the others down.
describe("toMcpServerConfigs — a malformed entry is skipped AND reported", () => {
  it("an entry with neither command nor url is skipped with a reason", () => {
    const { configs, skipped } = toMcpServerConfigs({ "plugin:x:empty": {} })
    expect(configs).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.serverName).toBe("plugin:x:empty")
    expect(skipped[0]?.reason).toMatch(/command|url/i)
  })

  it("one bad entry does not take the good ones with it", () => {
    const { configs, skipped } = toMcpServerConfigs({
      "plugin:a:bad": {},
      "plugin:b:good": { command: "ok" },
    })
    expect(configs.map((c) => c.serverName)).toEqual(["plugin:b:good"])
    expect(skipped.map((s) => s.serverName)).toEqual(["plugin:a:bad"])
  })

  it("an empty URL is as malformed as a missing one", () => {
    const { configs, skipped } = toMcpServerConfigs({ "plugin:x:blank": { url: "   " } })
    expect(configs).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})

// ── toSubagentRoles: a plugin's agent declarations → mountable roles ────────
// The security direction is STRUCTURAL, not documentary: the host declares the
// tools a plugin agent may use and the plugin's own `tools:` list can only
// NARROW it. There is deliberately no separate "default tools" concept, because
// a second list would be a second path to a tool outside the host's allowlist.
//
// Translation is unavoidable here. A plugin writes Claude Code's vocabulary
// (`Read`/`Glob`/`Grep`); this repo registers `read`/`glob`/`grep`. Handing the
// declared names straight through would grant NOTHING — every entry would fail
// to resolve, and (before resolveRoleTools reported it) in silence.
describe("toSubagentRoles", () => {
  const allowed = ["read", "glob", "grep", "write", "list_dir", "todo_write", "ask_user_input", "spawn_agent"]

  const agent = (over: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
    name: "code-simplifier",
    description: "Simplifies code.",
    systemPrompt: "You simplify.",
    ...over,
  })

  it("maps the plugin's vocabulary onto this repo's registry", () => {
    const { roles, unresolved } = toSubagentRoles([agent({ tools: ["Read", "Glob", "Grep"] })], { allowedTools: allowed })
    expect(roles).toEqual([
      {
        name: "code-simplifier",
        description: "Simplifies code.",
        systemPrompt: "You simplify.",
        tools: ["read", "glob", "grep"],
      },
    ])
    expect(unresolved).toEqual([])
  })

  it("maps the renames a case-fold cannot reach", () => {
    const { roles } = toSubagentRoles(
      [agent({ tools: ["LS", "TodoWrite", "AskUserQuestion", "Agent"] })],
      { allowedTools: allowed },
    )
    expect(roles[0]?.tools).toEqual(["list_dir", "todo_write", "ask_user_input", "spawn_agent"])
  })

  it("drops what it cannot map, REPORTS it, and keeps the rest", () => {
    const { roles, unresolved } = toSubagentRoles(
      [agent({ tools: ["Read", "NotebookRead", "Workflow", "KillShell"] })],
      { allowedTools: allowed },
    )
    expect(roles[0]?.tools).toEqual(["read"])
    expect(unresolved.map((u) => u.tool).sort()).toEqual(["KillShell", "NotebookRead", "Workflow"])
    expect(unresolved.every((u) => u.role === "code-simplifier")).toBe(true)
  })

  it("a scoped entry is not a tool name at all — dropped and reported", () => {
    const { roles, unresolved } = toSubagentRoles(
      [agent({ tools: ["Read", "Agent(a:one, a:two)"] })],
      { allowedTools: allowed },
    )
    expect(roles[0]?.tools).toEqual(["read"])
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]?.tool).toBe("Agent(a:one, a:two)")
    // the REASON is what makes the scoped-form branch load-bearing: without it
    // this entry still fails the allowlist lookup and still lands here, so only
    // the reason can tell the two paths apart
    expect(unresolved[0]?.reason).toMatch(/scoped/i)
  })

  it("a plugin can never widen past the host's allowlist", () => {
    // `bash` IS a real tool in this repo, but not one this host allows a plugin
    // agent to use. It must not reach the output by either path.
    const { roles, unresolved } = toSubagentRoles(
      [agent({ tools: ["Read", "Bash"] })],
      { allowedTools: ["read", "glob"] },
    )
    expect(roles[0]?.tools).toEqual(["read"])
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]?.tool).toBe("Bash")
    // `Bash` IS a form this repo knows, so it is refused as not-permitted —
    // a different problem from a form we do not implement
    expect(unresolved[0]?.reason).not.toMatch(/scoped/i)
  })

  it("no tools key means inherit the host's list; [] means none", () => {
    expect(toSubagentRoles([agent()], { allowedTools: allowed }).roles[0]?.tools).toEqual(allowed)
    expect(toSubagentRoles([agent({ tools: [] })], { allowedTools: allowed }).roles[0]?.tools).toEqual([])
  })

  it("model is NOT honoured — the provider belongs to the host", () => {
    const { roles } = toSubagentRoles([agent({ tools: ["Read"], model: "opus" })], { allowedTools: allowed })
    // the role itself still lands: without this the assertion below is satisfied
    // by a function that returns nothing at all
    expect(roles[0]?.tools).toEqual(["read"])
    expect(roles[0]).not.toHaveProperty("model")
    expect(JSON.stringify(roles)).not.toContain("opus")
  })
})
