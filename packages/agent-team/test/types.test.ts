import { describe, expect, it } from "vitest"
import { validateTeamConfig } from "../src/index.ts"

describe("validateTeamConfig", () => {
  it("accepts defaults and rejects bad bounds", () => {
    expect(() => validateTeamConfig({})).not.toThrow()
    expect(() => validateTeamConfig({ maxMembers: 4 })).not.toThrow()
    expect(() => validateTeamConfig({ maxMembers: 0 })).toThrow()
    expect(() => validateTeamConfig({ maxTasks: -1 })).toThrow()
    expect(() => validateTeamConfig({ maxMessageBytes: 1.5 })).toThrow()
    expect(() => validateTeamConfig({ waitMinMs: 5_000 })).toThrow() // < 10_000
  })
})
