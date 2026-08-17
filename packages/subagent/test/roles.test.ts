import { describe, expect, it } from "vitest"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"

describe("role registry", () => {
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
