import { describe, expect, it } from "vitest"
import { resolve as resolvePath } from "node:path"
import { createSession, append } from "@i-harness/core-session"
import { SANDBOX_MODES, createSandboxPolicy, effectiveSandboxMode, renderPolicyContext } from "../src/index.ts"

describe("SANDBOX_MODES", () => {
  it("is the closed vocabulary", () => {
    expect(SANDBOX_MODES).toEqual(["read-only", "workspace-write", "danger-full-access"])
  })
})

describe("effectiveSandboxMode", () => {
  it("last sandbox/mode event wins", () => {
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only" })
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "sandbox/mode", mode: "workspace-write" })
    expect(effectiveSandboxMode(s.events)).toBe("workspace-write")
  })

  it("undefined when no sandbox/mode event", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(effectiveSandboxMode(s.events)).toBeUndefined()
  })

  it("delegation source is carried", () => {
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only", source: "delegation" })
    expect(effectiveSandboxMode(s.events)).toBe("read-only")
  })
})

describe("createSandboxPolicy", () => {
  it("defaults to read-only and process.cwd()", () => {
    const policy = createSandboxPolicy({})
    expect(policy.defaultMode).toBe("read-only")
    expect(policy.workspaceRoot.length).toBeGreaterThan(0)
  })

  it("resolve: requested mode > session override > default", () => {
    const policy = createSandboxPolicy({ mode: "workspace-write", workspaceRoot: "/root" })
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "read-only" })
    expect(policy.resolve({ mode: "danger-full-access" }).mode).toBe("danger-full-access")
    expect(policy.resolve({ session: s }).mode).toBe("read-only") // session override
    expect(policy.resolve({}).mode).toBe("workspace-write") // default
  })

  it("workspaceRoot: request override ?? config default", () => {
    const policy = createSandboxPolicy({ workspaceRoot: "/config-root" })
    expect(policy.resolve({ workspaceRoot: "/call-root" }).workspaceRoot).toBe(resolvePath("/call-root"))
    expect(policy.resolve({}).workspaceRoot).toBe(resolvePath("/config-root"))
  })
})

describe("renderPolicyContext", () => {
  it("renders each mode", () => {
    expect(renderPolicyContext({ mode: "read-only", workspaceRoot: "/x" })).toContain("read-only")
    expect(renderPolicyContext({ mode: "workspace-write", workspaceRoot: "/x" })).toContain("/x")
    expect(renderPolicyContext({ mode: "danger-full-access", workspaceRoot: "/x" })).toContain("danger-full-access")
  })
})
