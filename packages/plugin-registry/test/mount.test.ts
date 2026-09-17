import { describe, expect, it } from "vitest"
import { toMcpServerConfigs } from "../src/mount.ts"

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
