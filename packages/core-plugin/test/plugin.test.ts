import { describe, expect, it } from "vitest"
import { corePluginVersion, createContext } from "../src/index.ts"
import type { Plugin } from "../src/index.ts"

describe("core-plugin", () => {
  it("exports a version", () => {
    expect(corePluginVersion).toBe("0.1.0")
  })
})

describe("four primitives", () => {
  it("registers and resolves a service", () => {
    const ctx = createContext()
    const svc = { value: 1 }
    ctx.services.register("svc", svc)
    expect(ctx.services.get<{ value: number }>("svc")).toBe(svc)
  })

  it("mounts and unmounts a plugin, reclaiming listeners", () => {
    const ctx = createContext()
    const calls: number[] = []
    const plugin: Plugin = {
      name: "p",
      mount(c) {
        c.on("ev", () => calls.push(1))
      },
    }
    ctx.mount(plugin)
    ctx.emit("ev", {})
    expect(calls).toEqual([1])
    ctx.unmount(plugin.name)
    ctx.emit("ev", {})
    expect(calls).toEqual([1]) // no second call — listener reclaimed
  })

  it("shadows service in child scope, restores on unmount", () => {
    const ctx = createContext()
    ctx.services.register("svc", { value: 1 })
    const child = ctx.scope.mount()
    child.services.register("svc", { value: 2 })
    expect(child.services.get<{ value: number }>("svc").value).toBe(2)
    expect(ctx.services.get<{ value: number }>("svc").value).toBe(1)
    child.scope.unmount()
    const child2 = ctx.scope.mount()
    expect(child2.services.get<{ value: number }>("svc").value).toBe(1)
  })

  it("throws on same-layer duplicate service name", () => {
    const ctx = createContext()
    ctx.services.register("dup", { a: 1 })
    expect(() => ctx.services.register("dup", { a: 2 })).toThrow(/duplicate/)
  })

  it("attributes listeners correctly when a plugin nests another mount", () => {
    const ctx = createContext()
    const calls: string[] = []
    const b: Plugin = {
      name: "b",
      mount(c) {
        c.on("ev", () => calls.push("b"))
      },
    }
    const a: Plugin = {
      name: "a",
      mount(c) {
        c.mount(b)
        // listener registered AFTER the nested mount must still be attributed to A
        c.on("ev", () => calls.push("a"))
      },
    }
    ctx.mount(a)
    ctx.emit("ev", {})
    expect(calls).toEqual(["b", "a"])
    ctx.unmount("a")
    ctx.emit("ev", {})
    // unmounting A reclaims BOTH A's listener and B's (B was mounted inside A's mount)
    expect(calls).toEqual(["b", "a"])
  })
})
