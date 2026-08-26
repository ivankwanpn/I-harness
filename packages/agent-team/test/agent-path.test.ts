import { describe, expect, it } from "vitest"
import { AgentPath } from "../src/index.ts"

describe("AgentPath", () => {
  it("root is 'lead'; parse validates kebab-case segments", () => {
    expect(AgentPath.root().toString()).toBe("lead")
    expect(AgentPath.parse("lead/helper").toString()).toBe("lead/helper")
    expect(AgentPath.parse("lead/my-helper-2").toString()).toBe("lead/my-helper-2")
  })

  it("rejects invalid names and reserved words", () => {
    expect(() => AgentPath.parse("lead/Bad")).toThrow()
    expect(() => AgentPath.parse("lead/bad_name")).toThrow()
    expect(() => AgentPath.parse("lead/..")).toThrow()
    expect(() => AgentPath.parse("lead/..")).toThrow()
    expect(() => AgentPath.parse("lead/lead")).toThrow()
    expect(() => AgentPath.parse("helper")).toThrow() // must be lead-prefixed
  })

  it("join and resolve relative/absolute", () => {
    const p = AgentPath.parse("lead/helper")
    expect(p.join("child").toString()).toBe("lead/helper/child")
    expect(p.resolve("sibling").toString()).toBe("lead/helper/sibling")
    expect(p.resolve("lead/abs").toString()).toBe("lead/abs")
  })

  it("name and isRoot", () => {
    expect(AgentPath.root().isRoot()).toBe(true)
    expect(AgentPath.parse("lead/helper").isRoot()).toBe(false)
    expect(AgentPath.parse("lead/helper").name()).toBe("helper")
  })
})
