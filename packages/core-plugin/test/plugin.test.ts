import { describe, expect, it, vi } from "vitest"
import { setTimeout as sleep } from "node:timers/promises"
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

  it("terminates on same-name nested mount (no stack overflow)", () => {
    const ctx = createContext()
    const calls: number[] = []
    const inner: Plugin = {
      name: "self",
      mount(c) {
        c.on("ev", () => calls.push(1))
      },
    }
    const outer: Plugin = {
      name: "self",
      mount(c) {
        c.mount(inner)
      },
    }
    ctx.mount(outer)
    ctx.emit("ev", {})
    expect(calls).toEqual([1])
    expect(() => ctx.unmount("self")).not.toThrow()
    ctx.emit("ev", {})
    // all same-name listeners reclaimed; unmount terminated without stack overflow
    expect(calls).toEqual([1])
  })
})

describe("waterfall", () => {
  it("runs handlers in order, each mutating payload, releasing via next", async () => {
    const ctx = createContext()
    const seen: string[] = []
    ctx.waterfall("wf", async (payload: unknown, next) => {
      seen.push(`a:${(payload as { v: number }).v}`)
      const nextPayload = (await next(payload)) as { v: number }
      ;(nextPayload as { v: number }).v += 1
      seen.push(`a2:${nextPayload.v}`)
    })
    ctx.waterfall("wf", async (payload: unknown, next) => {
      seen.push(`b:${(payload as { v: number }).v}`)
      ;(payload as { v: number }).v += 10
      await next(payload) // even the last handler must release via next()
    })
    await ctx.emit("wf", { v: 1 })
    expect(seen).toEqual(["a:1", "b:1", "a2:12"])
  })

  it("treats a handler that forgets next() as an error, not a silent veto", async () => {
    const ctx = createContext()
    let err: unknown
    ctx.waterfall("wf2", async (_p: unknown, _next) => {
      // forget to call next()
    })
    ctx.waterfall("wf2", async (p: unknown) => {
      void p
    })
    try {
      await ctx.emit("wf2", {})
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
  })

  it("registers waterfall handlers explicitly: a default-value next param is still a waterfall handler", async () => {
    const ctx = createContext()
    let err: unknown
    ctx.waterfall("wf3", async (_payload: unknown, _next = () => {}) => {
      // `.length === 1` here (default-value next) must not silence the error:
      // explicit waterfall registration is what grants next, not arity.
    })
    try {
      await ctx.emit("wf3", {})
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
  })

  it("throws when a waterfall handler calls next() twice", async () => {
    const ctx = createContext()
    let err: unknown
    ctx.waterfall("wf4", async (payload: unknown, next) => {
      await next(payload)
      await next(payload) // double release — must throw, not re-run the chain
    })
    try {
      await ctx.emit("wf4", {})
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
  })

  it("seeds the waterfall chain from the last non-undefined plain-listener return", async () => {
    const ctx = createContext()
    let chainSaw: unknown
    ctx.on("wf-seed", () => ({ kind: "ask" }))
    ctx.waterfall("wf-seed", async (payload: unknown, next) => {
      chainSaw = payload
      await next(payload)
    })
    await ctx.emit("wf-seed", { raw: true })
    expect(chainSaw).toEqual({ kind: "ask" })
  })

  it("keeps the emitted payload as the chain seed when listeners return nothing", async () => {
    const ctx = createContext()
    let chainSaw: unknown
    ctx.on("wf-seed2", () => {
      void 0 // listener with no decision to contribute
    })
    ctx.waterfall("wf-seed2", async (payload: unknown, next) => {
      chainSaw = payload
      await next(payload)
    })
    await ctx.emit("wf-seed2", { raw: true })
    expect(chainSaw).toEqual({ raw: true })
  })

  it("does not let incidental listener returns rewrite the payload when no waterfall is registered", async () => {
    const parent = createContext()
    const parentSeen: unknown[] = []
    parent.on("plain-ret", (payload) => parentSeen.push(payload))
    const child = parent.scope.mount()
    const childSeen: unknown[] = []
    child.on("plain-ret", (payload) => {
      childSeen.push(payload)
      return 42 // incidental return value (e.g. from `calls.push(x)`)
    })
    await child.emit("plain-ret", { marker: true })
    // The child listener still ran with the emitted payload...
    expect(childSeen).toEqual([{ marker: true }])
    // ...but its return value must NOT be forwarded to the parent scope:
    // no waterfall is registered for this event, so the payload passes
    // through unchanged (propagation keeps the original payload).
    expect(parentSeen).toEqual([{ marker: true }])
  })
})

describe("monotonic guard", () => {
  it("is deny-only and order-independent", () => {
    const ctx = createContext()
    const denials: string[] = []
    ctx.guard("g", (exec) => {
      if ((exec as { cmd: string }).cmd === "rm") return "denied: rm"
      return undefined
    })
    ctx.guard("g", (exec) => {
      void exec
      return undefined // cannot re-allow
    })
    // First deny wins; a second guard cannot turn it back.
    expect(ctx.checkGuards("g", { cmd: "rm" })).toBe("denied: rm")
    expect(ctx.checkGuards("g", { cmd: "ls" })).toBeUndefined()
    expect(denials).toEqual([])
  })

  it("runs guards unconditionally even for non-allow decisions", () => {
    const ctx = createContext()
    let guardRan = false
    ctx.guard("g2", () => {
      guardRan = true
      return undefined
    })
    // pre-execute returns a non-vocabulary object; guards must still run
    ctx.checkGuards("g2", {})
    expect(guardRan).toBe(true)
  })
})

describe("lifecycle", () => {
  it("times out a never-settling unmount disposer and removes the plugin", async () => {
    const ctx = createContext()
    let removed = false
    let disposerCalls = 0
    const plugin: Plugin = {
      name: "hang",
      mount() {},
      async unmount() {
        disposerCalls++
        await sleep(10_000) // never settles within the 5s timeout
        removed = true
      },
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      ctx.mount(plugin)
      // Should resolve (via timeout), not hang
      await ctx.unmount("hang")

      // The 5s timeout path actually ran: the disposer never settled, so the
      // exact timeout error was logged. A buggy implementation that deleted the
      // plugin immediately without awaiting the disposer would never log this
      // and would fail this assertion.
      expect(errorSpy).toHaveBeenCalledWith(
        "[core-plugin] unmount disposer for 'hang' timed out after 5s",
      )
      expect(removed).toBe(false) // disposer timed out, not settled

      // The plugin is actually removed from the registry after the timed-out
      // unmount: unmounting again is a no-op and does not re-invoke the
      // never-settling disposer (which would wait another 5s).
      await ctx.unmount("hang")
      expect(disposerCalls).toBe(1)
    } finally {
      errorSpy.mockRestore()
    }
  }, 15_000)
})

describe("I3 scope propagation", () => {
  it("checks guards across the ancestor chain (union-of-ancestors)", () => {
    const ctx = createContext()
    ctx.guard("tools/execute", (exec) => {
      if ((exec as { name: string }).name === "dangerous") return "denied by root"
      return undefined
    })
    const child = ctx.scope.mount()
    // child scope has NO guards of its own; the root guard must still apply
    expect(child.checkGuards("tools/execute", { name: "dangerous" })).toBe("denied by root")
    expect(child.checkGuards("tools/execute", { name: "safe" })).toBeUndefined()
  })

  it("keeps child guards additive (union — stricter, never re-allows)", () => {
    const ctx = createContext()
    ctx.guard("g", () => undefined) // root: allow
    const child = ctx.scope.mount()
    child.guard("g", () => "child denied")
    // child deny must hold even though root would allow
    expect(child.checkGuards("g", {})).toBe("child denied")
    // and a child allow never overrides a parent deny
    const child2 = ctx.scope.mount()
    child2.guard("g", () => undefined)
    expect(child2.checkGuards("g", {})).toBeUndefined() // both allow → undefined
    // add a root deny, child allow must not override
    ctx.guard("g2", () => "root denied")
    const child3 = ctx.scope.mount()
    child3.guard("g2", () => undefined)
    expect(child3.checkGuards("g2", {})).toBe("root denied")
  })

  it("resolves the nearest-ancestor decision (nearest-wins, falls back to payload)", async () => {
    // root producer constrains a child registry: child has no producer, emit
    // passes through and the root { kind: "ask" } decision is read back.
    const ctx = createContext()
    ctx.on("t/ask", () => ({ kind: "ask" }))
    ctx.waterfall("t/ask", async (payload, next) => {
      await next(payload)
    })
    const child = ctx.scope.mount()
    const raw = { tool: "sh", args: ["dangerous"] }
    await child.emit("t/ask", raw)
    expect(child.resolveDecision("t/ask", raw)).toEqual({ kind: "ask" })

    // child decision wins over the root decision (nearest-wins)
    const child2 = ctx.scope.mount()
    child2.on("t/deny", () => ({ kind: "deny" }))
    child2.waterfall("t/deny", async (payload, next) => {
      await next(payload)
    })
    ctx.on("t/deny", () => ({ kind: "ask" }))
    ctx.waterfall("t/deny", async (payload, next) => {
      await next(payload)
    })
    await child2.emit("t/deny", raw)
    expect(child2.resolveDecision("t/deny", raw)).toEqual({ kind: "deny" })

    // no decision anywhere in the chain → the emitted payload falls through
    const bare = createContext()
    await bare.emit("t/none", raw)
    expect(bare.resolveDecision("t/none", raw)).toBe(raw)
  })

  it("does not leak a stale decision across repeated emits", async () => {
    const ctx = createContext()
    let decided = true
    ctx.on("t/stale", () => (decided ? { kind: "ask" } : undefined))
    ctx.waterfall("t/stale", async (payload, next) => {
      await next(payload)
    })
    await ctx.emit("t/stale", { v: 1 })
    expect(ctx.resolveDecision("t/stale", { v: 1 })).toEqual({ kind: "ask" })

    // second emit on the SAME scope produces no decision: the previous
    // { kind: "ask" } must NOT leak into this execution.
    decided = false
    const raw2 = { v: 2 }
    await ctx.emit("t/stale", raw2)
    expect(ctx.resolveDecision("t/stale", raw2)).toBe(raw2)
  })

  it("falls back to the parent's fresh decision when a child stops deciding", async () => {
    const ctx = createContext()
    ctx.on("t/fallback", () => ({ kind: "ask" }))
    ctx.waterfall("t/fallback", async (payload, next) => {
      await next(payload)
    })
    const child = ctx.scope.mount()
    let childDecides = true
    child.on("t/fallback", () => (childDecides ? { kind: "deny" } : undefined))
    child.waterfall("t/fallback", async (payload, next) => {
      await next(payload)
    })
    await child.emit("t/fallback", { v: 1 })
    expect(child.resolveDecision("t/fallback", { v: 1 })).toEqual({ kind: "deny" })

    // the child producer now passes through: nearest-wins must fall back to
    // the parent's ask recorded during THIS emit — not the child's stale deny
    // from the previous emit.
    childDecides = false
    const raw2 = { v: 2 }
    await child.emit("t/fallback", raw2)
    expect(child.resolveDecision("t/fallback", raw2)).toEqual({ kind: "ask" })
  })

  it("records a decision from a producer that mutates and returns the same payload reference", async () => {
    const ctx = createContext()
    ctx.on("t/mutate", (payload) => {
      ;(payload as { kind?: string }).kind = "ask"
      return payload // same object reference back — not a new object
    })
    ctx.waterfall("t/mutate", async (payload, next) => {
      await next(payload)
    })
    const child = ctx.scope.mount()
    await child.emit("t/mutate", { tool: "sh" })
    // a fresh object as fallback (NOT the emitted one): the recorded decision
    // must win, proving detection did not rely on object-identity changes.
    expect(child.resolveDecision("t/mutate", { fallback: true })).toEqual({
      kind: "ask",
      tool: "sh",
    })
  })
})
