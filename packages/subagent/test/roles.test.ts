import { describe, expect, it } from "vitest"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"

describe("role registry", () => {
  it("publishes a monotonic role revision synchronously at mutation", () => {
    const roles = createRoleRegistry()
    const seen: number[] = []
    roles.onChanged(() => { seen.push(roles.revision()) })
    roles.register({ name: "test", description: "test", systemPrompt: "test", tools: [] })
    roles.remove("test")
    expect(seen).toEqual([1, 2])
  })
  it("makes selected shell available only to implementation roles when the host mounts it", () => {
    const roles = builtinRoles({ agentShell: true })
    expect(roles.find((role) => role.name === "general")!.tools).toContain("shell")
    expect(roles.find((role) => role.name === "worker")!.tools).toContain("shell")
    expect(roles.find((role) => role.name === "explore")!.tools).not.toContain("shell")
    expect(builtinRoles().flatMap((role) => role.tools)).not.toContain("shell")
  })
  it("seeds four built-in roles", () => {
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const names = roles.list().map((r) => r.name).sort()
    expect(names).toEqual(["explore", "general", "research", "worker"])
  })

  it("register/get/list/remove and duplicate detection", () => {
    const roles = createRoleRegistry()
    roles.register({ name: "reviewer", description: "reviews code", systemPrompt: "You review.", tools: ["read"], model: { provider: "p", model: "m" } })
    expect(roles.get("reviewer")?.description).toBe("reviews code")
    expect(() => roles.register({ name: "reviewer", description: "x", systemPrompt: "y", tools: [] })).toThrow(/duplicate/i)
    roles.remove("reviewer")
    expect(roles.get("reviewer")).toBeUndefined()
  })
})
