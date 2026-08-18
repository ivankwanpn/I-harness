import { describe, expect, it } from "vitest"
import { createContext } from "../src/index.ts"
import type { Plugin } from "../src/index.ts"

describe("cascade", () => {
  it("composes handlers outside-in over the final function", async () => {
    const ctx = createContext()
    const results: string[] = []
    ctx.onCascade("ev", async (_input, next) => {
      results.push("A-pre")
      const r = await next()
      results.push("A-post")
      return r
    })
    ctx.onCascade("ev", async (_input, next) => {
      results.push("B-pre")
      const r = await next()
      results.push("B-post")
      return r
    })
    const out = await ctx.cascade("ev", 1, async () => {
      results.push("final")
      return "out"
    })
    expect(results).toEqual(["A-pre", "B-pre", "final", "B-post", "A-post"])
    expect(out).toBe("out")
  })

  it("lets a handler observe and wrap the inner result", async () => {
    const ctx = createContext()
    ctx.onCascade("ev", async (_input, next) => (await next()) + "-wrapped")
    const out = await ctx.cascade("ev", 1, async () => "out")
    expect(out).toBe("out-wrapped")
  })

  it("short-circuits when a handler skips next(), without running final", async () => {
    const ctx = createContext()
    let finalRan = false
    ctx.onCascade("ev", async (_input) => "stop")
    const out = await ctx.cascade("ev", 1, async () => {
      finalRan = true
      return "final"
    })
    expect(out).toBe("stop")
    expect(finalRan).toBe(false)
  })

  it("throws when a handler calls next() twice", async () => {
    const ctx = createContext()
    ctx.onCascade("ev", async (_input, next) => {
      await next()
      await next() // double release — must throw, not re-run the chain
      return "unreachable"
    })
    await expect(ctx.cascade("ev", 1, async () => "final")).rejects.toThrow(
      /called next\(\) twice/,
    )
  })

  it("runs final directly when no handlers are registered", async () => {
    const ctx = createContext()
    const out = await ctx.cascade("plain", { v: 1 }, async () => "direct")
    expect(out).toBe("direct")
  })

  it("does not run plain ctx.on listeners during a cascade dispatch", async () => {
    const ctx = createContext()
    const plainRuns: number[] = []
    ctx.on("ev", (payload) => {
      plainRuns.push((payload as { v: number }).v)
    })
    const out = await ctx.cascade("ev", { v: 1 }, async () => "via-cascade")
    expect(out).toBe("via-cascade")
    // dispatch is cascade-handlers only — the plain listener must not touch the input
    expect(plainRuns).toEqual([])
  })

  it("reclaims a plugin's cascade handlers on unmount", async () => {
    const ctx = createContext()
    const plugin: Plugin = {
      name: "p-cascade",
      mount(c) {
        c.onCascade("owned", async (_input, next) => `wrapped:${await next()}`)
      },
    }
    ctx.mount(plugin)
    const out1 = await ctx.cascade("owned", 1, async () => "final1")
    expect(out1).toBe("wrapped:final1")
    await ctx.unmount(plugin.name)
    // handler reclaimed — the next dispatch runs final directly
    const out2 = await ctx.cascade("owned", 1, async () => "final2")
    expect(out2).toBe("final2")
  })
})
