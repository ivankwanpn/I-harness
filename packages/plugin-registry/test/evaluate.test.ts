import { describe, expect, it } from "vitest"
import { evaluatePlugin, type Observations } from "../src/evaluate.ts"
import type { Capabilities } from "../src/capability.ts"
import type { PluginRecord } from "../src/types.ts"

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "m__p",
    marketplace: "m",
    name: "p",
    installPath: "/plugins/m__p",
    installed: true,
    enabled: true,
    ...overrides,
  }
}

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return { skills: false, commands: false, mcp: false, executable: false, ...overrides }
}

function obs(overrides: Partial<Observations> = {}): Observations {
  return {
    skillNamesByDir: new Map<string, string[]>(),
    commandNames: new Set<string>(),
    expectedCommandNames: [],
    expectedMcpServerNames: [],
    connectedMcpServers: new Set<string>(),
    initialized: true,
    ...overrides,
  }
}

describe("evaluatePlugin", () => {
  it("not enabled → overall disabled and every runtime dimension disabled", () => {
    const r = evaluatePlugin(
      record({ enabled: false }),
      caps({ skills: true, commands: true, mcp: true }),
      obs(),
    )
    expect(r.overall).toBe("disabled")
    expect(r.capabilities).toEqual({
      skills: "disabled",
      commands: "disabled",
      mcp: "disabled",
      executable: "unsupported",
    })
    expect(r.commandStatuses).toEqual({})
  })

  it("disabling wins over pending observations (no initializing leak)", () => {
    const r = evaluatePlugin(
      record({ enabled: false }),
      caps({ skills: true }),
      obs({ initialized: false }),
    )
    expect(r.overall).toBe("disabled")
  })

  it("executable-only plugin (no other advertised dim) → overall failed, dims unsupported", () => {
    const r = evaluatePlugin(
      record(),
      caps({ executable: true }),
      obs(),
    )
    expect(r.capabilities).toEqual({
      skills: "unsupported",
      commands: "unsupported",
      mcp: "unsupported",
      executable: "unsupported",
    })
    expect(r.overall).toBe("failed")
  })

  it("executable capability → always unsupported, does not degrade overall", () => {
    const r = evaluatePlugin(
      record(),
      caps({
        skills: true,
        commands: true,
        mcp: true,
        executable: true,
      }),
      obs({
        skillNamesByDir: new Map([["m__p", ["a.md"]]]),
        commandNames: new Set(["hello", "meta"]),
        expectedCommandNames: ["hello", "meta"],
        expectedMcpServerNames: ["plugin:m__p:srv"],
        connectedMcpServers: new Set(["plugin:m__p:srv"]),
      }),
    )
    expect(r.capabilities.executable).toBe("unsupported")
    expect(r.overall).toBe("ready")
  })

  it("not initialized → applicable dimensions pending, overall initializing", () => {
    const r = evaluatePlugin(
      record(),
      caps({ skills: true, commands: true, mcp: true }),
      obs({ initialized: false }),
    )
    expect(r.capabilities).toEqual({
      skills: "pending",
      commands: "pending",
      mcp: "pending",
      executable: "unsupported",
    })
    expect(r.overall).toBe("initializing")
    expect(r.commandStatuses).toEqual({})
  })

  it("skills: observed names present for the plugin → ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ skills: true }),
      obs({ skillNamesByDir: new Map([["m__p", ["a.md", "b/"]], ["other__x", ["z.md"]]]) }),
    )
    expect(r.capabilities.skills).toBe("ready")
    expect(r.overall).toBe("ready")
  })

  it("skills: no observation after init → failed, overall failed", () => {
    const r = evaluatePlugin(record(), caps({ skills: true }), obs())
    expect(r.capabilities.skills).toBe("failed")
    expect(r.overall).toBe("failed")
  })

  it("skills: observed dir present but empty → failed (no usable skill)", () => {
    const r = evaluatePlugin(
      record(),
      caps({ skills: true }),
      obs({ skillNamesByDir: new Map([["m__p", []]]) }),
    )
    expect(r.capabilities.skills).toBe("failed")
    expect(r.overall).toBe("failed")
  })

  it("commands: every expected name registered → ready, per-command ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ commands: true }),
      obs({
        commandNames: new Set(["hello", "meta"]),
        expectedCommandNames: ["meta", "hello"],
      }),
    )
    expect(r.capabilities.commands).toBe("ready")
    expect(r.commandStatuses).toEqual({ meta: "ready", hello: "ready" })
    expect(r.overall).toBe("ready")
  })

  it("commands: one expected name missing (unregistered, non-conflict) → failed, overall failed", () => {
    const r = evaluatePlugin(
      record(),
      caps({ commands: true }),
      obs({
        commandNames: new Set(["a"]),
        expectedCommandNames: ["a", "b"],
      }),
    )
    expect(r.capabilities.commands).toBe("failed")
    expect(r.commandStatuses).toEqual({ a: "ready", b: "failed" })
    expect(r.overall).toBe("failed")
  })

  it("commands: conflicted name is failed even when the name is registered (host's) → overall degraded", () => {
    const r = evaluatePlugin(
      record({ conflicts: [{ name: "hello", reason: "already registered by the host" }] }),
      caps({ commands: true }),
      obs({
        commandNames: new Set(["hello", "meta"]), // hello belongs to the host
        expectedCommandNames: ["hello", "meta"],
      }),
    )
    expect(r.capabilities.commands).toBe("failed")
    expect(r.commandStatuses).toEqual({ hello: "failed", meta: "ready" })
    expect(r.overall).toBe("degraded")
  })

  it("commands: host-only names in the interaction catalog are ignored", () => {
    const r = evaluatePlugin(
      record(),
      caps({ commands: true }),
      obs({
        commandNames: new Set(["a", "host-cmd", "other-plugin-cmd"]),
        expectedCommandNames: ["a"],
      }),
    )
    expect(r.capabilities.commands).toBe("ready")
    expect(r.commandStatuses).toEqual({ a: "ready" })
    expect(r.overall).toBe("ready")
  })

  it("commands: conflicted + non-conflict unregistered mixed → overall failed (not degraded)", () => {
    const r = evaluatePlugin(
      record({ conflicts: [{ name: "hello", reason: "already provided by enabled plugin other" }] }),
      caps({ commands: true }),
      obs({
        commandNames: new Set(["a"]),
        expectedCommandNames: ["hello", "a", "b"],
      }),
    )
    expect(r.commandStatuses).toEqual({ hello: "failed", a: "ready", b: "failed" })
    // only-name failures are not conflicts for every failed entry → failed
    expect(r.overall).toBe("failed")
  })

  it("commands: conflict names not in the expected set are ignored (stale conflict)", () => {
    const r = evaluatePlugin(
      record({ conflicts: [{ name: "stale-name", reason: "already registered by the host" }] }),
      caps({ commands: true }),
      obs({ commandNames: new Set(["a"]), expectedCommandNames: ["a"] }),
    )
    expect(r.commandStatuses).toEqual({ a: "ready" })
    expect(r.capabilities.commands).toBe("ready")
    expect(r.overall).toBe("ready")
  })

  it("commands: zero expected names → vacuous ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ commands: true }),
      obs({ commandNames: new Set(["host-cmd"]) }),
    )
    expect(r.capabilities.commands).toBe("ready")
    expect(r.commandStatuses).toEqual({})
    expect(r.overall).toBe("ready")
  })

  it("mcp: every expected server connected → ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ mcp: true }),
      obs({
        expectedMcpServerNames: ["plugin:m__p:srvA", "plugin:m__p:srvB"],
        connectedMcpServers: new Set(["plugin:m__p:srvA", "plugin:m__p:srvB", "prototype:http"]),
      }),
    )
    expect(r.capabilities.mcp).toBe("ready")
    expect(r.overall).toBe("ready")
  })

  it("mcp: no declared servers (vacuous) → ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ mcp: true }),
      obs({ expectedMcpServerNames: [], connectedMcpServers: new Set(["plugin:other__x:srv"]) }),
    )
    expect(r.capabilities.mcp).toBe("ready")
    expect(r.overall).toBe("ready")
  })

  it("mcp: one server missing → failed, overall failed", () => {
    const r = evaluatePlugin(
      record(),
      caps({ mcp: true }),
      obs({
        expectedMcpServerNames: ["plugin:m__p:srvA", "plugin:m__p:srvB"],
        connectedMcpServers: new Set(["plugin:m__p:srvA"]),
      }),
    )
    expect(r.capabilities.mcp).toBe("failed")
    expect(r.overall).toBe("failed")
  })

  it("mcp failure dominates: conflict-only commands + mcp failure → overall failed", () => {
    const r = evaluatePlugin(
      record({ conflicts: [{ name: "hello", reason: "already registered by the host" }] }),
      caps({ commands: true, mcp: true }),
      obs({
        commandNames: new Set(["hello", "meta"]),
        expectedCommandNames: ["hello", "meta"],
        expectedMcpServerNames: ["plugin:m__p:srvA", "plugin:m__p:srvB"],
        connectedMcpServers: new Set(["plugin:m__p:srvA"]),
      }),
    )
    expect(r.overall).toBe("failed")
  })

  it("not advertised dimensions → unsupported while others evaluate", () => {
    const r = evaluatePlugin(
      record(),
      caps({ skills: true }), // only skills
      obs({ skillNamesByDir: new Map([["m__p", ["a.md"]]]) }),
    )
    expect(r.capabilities).toEqual({
      skills: "ready",
      commands: "unsupported",
      mcp: "unsupported",
      executable: "unsupported",
    })
    expect(r.overall).toBe("ready")
  })

  it("everything ready → overall ready", () => {
    const r = evaluatePlugin(
      record(),
      caps({ skills: true, commands: true, mcp: true }),
      obs({
        skillNamesByDir: new Map([["m__p", ["a.md"]]]),
        commandNames: new Set(["hello"]),
        expectedCommandNames: ["hello"],
        expectedMcpServerNames: ["plugin:m__p:srv"],
        connectedMcpServers: new Set(["plugin:m__p:srv"]),
      }),
    )
    expect(r.overall).toBe("ready")
    expect(Object.values(r.capabilities).filter((s) => s === "ready").length).toBe(3)
  })
})
