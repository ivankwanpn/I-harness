import { describe, expect, it } from "vitest"
import { CASCADE_REDISPATCH, createContext, isCascadeRedispatch, markCascadeRedispatch } from "../src/index.ts"

describe("scope extraction contracts", () => {
  it("reads the live immediate parent store without extending service inheritance", () => {
    const root = createContext()
    const child = root.scope.mount()
    const grandchild = child.scope.mount()
    const late = { value: 7 }
    root.services.register("late", late)
    expect(child.services.get("late")).toBe(late)
    expect(() => grandchild.services.get("late")).toThrow("service not found: late")
    child.services.register("own", late)
    expect(grandchild.services.get("own")).toBe(late)
  })

  it("snapshots listeners and waterfalls before a listener registers more handlers", async () => {
    const root = createContext()
    const child = root.scope.mount()
    const seen: string[] = []
    child.on("ev", () => {
      seen.push("original")
      child.on("ev", () => { seen.push("late-listener") })
      child.waterfall("ev", async (payload, next) => {
        seen.push("late-waterfall")
        return next(payload)
      })
      return "decision"
    })
    root.on("ev", (payload) => { seen.push(`parent:${payload}`) })
    expect(await child.emit("ev", "first")).toBe("first")
    expect(seen).toEqual(["original", "parent:first"])
    seen.length = 0
    expect(await child.emit("ev", "second")).toBe("decision")
    expect(seen).toEqual(["original", "late-listener", "late-waterfall", "parent:decision"])
  })

  it("retains the current waterfall frame's payload when its return is undefined", async () => {
    const ctx = createContext()
    const outer = { frame: "outer" }
    const inner = { frame: "inner" }
    ctx.waterfall("ev", async (_payload, next) => {
      expect(await next(inner)).toBe(inner)
    })
    ctx.waterfall("ev", async (payload, next) => {
      expect(payload).toBe(inner)
      await next(undefined)
    })
    expect(await ctx.emit("ev", outer)).toBe(outer)
  })

  it("takes ancestor cascade snapshots before handlers add or reclaim a child handler", async () => {
    const root = createContext()
    const child = root.scope.mount()
    const seen: string[] = []
    root.onCascade("ev", async (_payload, next) => {
      child.onCascade("ev", async (_input, release) => {
        seen.push("late")
        return release()
      })
      void child.unmount("owned")
      return next()
    })
    child.mount({
      name: "owned",
      mount(ctx) {
        ctx.onCascade("ev", async (_input, next) => {
          seen.push("owned")
          return next()
        })
      },
    })
    expect(await child.cascade("ev", {}, async () => "first")).toBe("first")
    expect(seen).toEqual(["owned"])
    seen.length = 0
    expect(await child.cascade("ev", {}, async () => "second")).toBe("second")
    expect(seen).toEqual(["late"])
  })

  it("reclaims all nested dispatch registrations synchronously before awaiting a disposer", async () => {
    const ctx = createContext()
    const seen: string[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    ctx.mount({
      name: "outer",
      mount(c) {
        c.mount({
          name: "inner",
          mount(inner) {
            inner.on("ev", () => { seen.push("listener") })
            inner.waterfall("ev", async (payload, next) => {
              seen.push("waterfall")
              return next(payload)
            })
            inner.onCascade("ev", async (_input, next) => {
              seen.push("cascade")
              return next()
            })
          },
          unmount() { seen.push("inner-dispose") },
        })
        c.on("ev", () => { seen.push("outer-listener") })
      },
      unmount() {
        seen.push("outer-dispose")
        return pending
      },
    })
    const unmounting = ctx.unmount("outer")
    const emitted = ctx.emit("ev", "payload")
    const cascaded = ctx.cascade("ev", {}, async () => "final")
    expect(seen).toEqual(["outer-dispose", "inner-dispose"])
    expect(await emitted).toBe("payload")
    expect(await cascaded).toBe("final")
    release()
    await unmounting
  })

  it("propagates listener, waterfall, cascade and guard errors without parent dispatch", async () => {
    const root = createContext()
    const child = root.scope.mount()
    const error = new Error("control flow failure")
    let parentRuns = 0
    root.on("listener", () => { parentRuns++ })
    root.on("waterfall", () => { parentRuns++ })
    child.on("listener", () => { throw error })
    child.waterfall("waterfall", () => { throw error })
    child.onCascade("cascade", async () => { throw error })
    root.guard("guard", () => { throw error })
    await expect(child.emit("listener", {})).rejects.toBe(error)
    await expect(child.emit("waterfall", {})).rejects.toBe(error)
    await expect(child.cascade("cascade", {}, async () => "unused")).rejects.toBe(error)
    expect(() => child.checkGuards("guard", {})).toThrow(error)
    expect(parentRuns).toBe(0)
  })

  it("preserves per-call emit results across overlapping asynchronous listener returns", async () => {
    const ctx = createContext()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    ctx.on("ev", async (payload) => {
      if (payload === "first") await wait
      return { decision: payload }
    })
    ctx.waterfall("ev", async (payload, next) => next(payload))
    const first = ctx.emit("ev", "first")
    const second = await ctx.emit("ev", "second")
    release()
    expect(await first).toEqual({ decision: "first" })
    expect(second).toEqual({ decision: "second" })
  })

  it("restores mounting ownership after a throwing nested mount without rolling registrations back", async () => {
    const ctx = createContext()
    const seen: string[] = []
    ctx.mount({
      name: "outer",
      mount(c) {
        expect(() => c.mount({
          name: "inner",
          mount(inner) {
            inner.on("ev", () => { seen.push("inner") })
            throw new Error("mount failure")
          },
        })).toThrow("mount failure")
        c.on("ev", () => { seen.push("outer") })
      },
    })
    await ctx.unmount("inner")
    await ctx.emit("ev", {})
    expect(seen).toEqual(["outer"])
    await ctx.unmount("outer")
    await ctx.emit("ev", {})
    expect(seen).toEqual(["outer"])
  })

  it("keeps redispatch marking on the global symbol and out of serialized payloads", () => {
    const payload = { name: "tool" }
    expect(CASCADE_REDISPATCH).toBe(Symbol.for("i-harness.cascade.redispatch"))
    expect(isCascadeRedispatch(payload)).toBe(false)
    markCascadeRedispatch(payload)
    expect(isCascadeRedispatch(payload)).toBe(true)
    expect(JSON.stringify(payload)).toBe('{"name":"tool"}')
  })
})
