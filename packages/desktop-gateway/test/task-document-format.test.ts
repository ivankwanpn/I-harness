import { describe, expect, it } from "vitest"
import { supportedTaskDocument } from "../src/subagents/catalog.ts"
import { currentTaskFormat } from "../src/subagents/catalog-provenance.ts"

describe("task document formats", () => {
  it("accepts every persisted task document shape", () => {
    for (const formatVersion of [1, 2]) expect(supportedTaskDocument({ formatVersion, tasks: [] })).toBe(true)
    expect(supportedTaskDocument({ formatVersion: 3, tasks: [], notifications: [] })).toBe(true)
  })

  it('rejects malformed current documents through the canonical V3 codec', () => {
    expect(supportedTaskDocument({ formatVersion: 3, tasks: [] })).toBe(false)
    expect(supportedTaskDocument({ formatVersion: 3, tasks: [], notifications: 'invalid' })).toBe(false)
    expect(supportedTaskDocument({ formatVersion: 3, tasks: [{ id: 'incomplete' }], notifications: [] })).toBe(false)
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
