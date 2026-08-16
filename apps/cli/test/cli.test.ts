import { describe, expect, it } from "vitest"
import { hello } from "../src/index.ts"

describe("cli", () => {
  it("greets", () => {
    expect(hello("world")).toBe("hello, world")
  })
})
