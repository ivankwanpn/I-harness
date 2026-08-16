import { describe, expect, it } from "vitest"
import { corePluginVersion } from "../src/index.ts"

describe("core-plugin", () => {
  it("exports a version", () => {
    expect(corePluginVersion).toBe("0.1.0")
  })
})
