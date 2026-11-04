import { describe, expect, it } from "vitest"
import { supportedTaskDocument } from "../src/subagents/catalog.ts"
import { currentTaskFormat } from "../src/subagents/catalog-provenance.ts"

describe("task document formats", () => {
  it("accepts every persisted task document shape", () => {
    for (const formatVersion of [1, 2, 3]) expect(supportedTaskDocument({ formatVersion, tasks: [] })).toBe(true)
  })

  it("rejects unknown versions and a missing task array", () => {
    expect(supportedTaskDocument({ formatVersion: 4, tasks: [] })).toBe(false)
    expect(supportedTaskDocument({ formatVersion: 3 })).toBe(false)
    expect(supportedTaskDocument({ tasks: [] })).toBe(false)
  })

  it("treats v2 and v3 as the current task format", () => {
    expect(currentTaskFormat({}, 2)).toBe(true)
    expect(currentTaskFormat({}, 3)).toBe(true)
    expect(currentTaskFormat({}, 1)).toBe(false)
  })
})
