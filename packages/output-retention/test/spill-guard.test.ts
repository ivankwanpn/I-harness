import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createOutputSpillGuard, gcSpillStore } from "../src/spill-guard.ts"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mkdir = () => mkdtempSync(join(tmpdir(), "m26-spill-"))

it("string output over the budget is truncated head-tail + notice with the spill path", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({
    name: "big", description: "", inputSchema: {},
    execute: async () => "A".repeat(10_000),
  } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  const result = await registry.execute({ name: "big", args: {} })
  const out = result.output as string
  expect(out.length).toBeLessThan(500)
  expect(out).toContain("Full result stored at:")
  expect(out).toContain("A") // retained tail
  const path = /Full result stored at: (.+?)\. Use read/.exec(out)![1]
  expect(readFileSync(path, "utf-8")).toBe("A".repeat(10_000))
  rmSync(root, { recursive: true, force: true })
})

it("under-budget string outputs pass through untouched", async () => {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({ name: "small", description: "", inputSchema: {}, execute: async () => "ok" } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: mkdir() }))
  const result = await registry.execute({ name: "small", args: {} })
  expect(result.output).toBe("ok")
})

it("object output over budget becomes { output, outputPaths, spill } envelope", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registry.register({ name: "obj", description: "", inputSchema: {}, execute: async () => ({ blob: "B".repeat(5000) }) } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  const result = await registry.execute({ name: "obj", args: {} })
  const out = result.output as { output: string; outputPaths: string[]; spill: { omittedBytes: number } }
  expect(Array.isArray(out.outputPaths)).toBe(true)
  expect(out.outputPaths![0]).toContain(root)
  expect(readFileSync(out.outputPaths![0], "utf-8")).toContain('"BBBB')
  expect(out.spill.omittedBytes).toBeGreaterThan(4000)
})

it("never replaces a `read` result — a truncated read would send the model back to read again", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const big = "A".repeat(10_000) // ONE oversized string, served by BOTH tools
  registry.register({ name: "read", description: "", inputSchema: {}, execute: async () => big } as Tool)
  registry.register({ name: "other", description: "", inputSchema: {}, execute: async () => big } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  // SAME registry, SAME oversized string, different tool name only — so the two
  // outcomes below can be attributed to the name and to nothing else.
  const other = await registry.execute({ name: "other", args: {} })
  expect(other.output as string).toContain("Full result stored at:") // the guard IS live here
  const read = await registry.execute({ name: "read", args: {} })
  expect(read.output).toBe(big) // byte-identical: untouched. A truncated read is a read→spill→read loop.
  rmSync(root, { recursive: true, force: true })
})

it("the skip covers the object path too — a real `read` returns `{ content }`, not a string", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const big = { content: "A".repeat(10_000) } // the shape the fs package's `read` really returns
  registry.register({ name: "read", description: "", inputSchema: {}, execute: async () => big } as Tool)
  registry.register({ name: "other", description: "", inputSchema: {}, execute: async () => big } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 100, spillRoot: root }))
  const other = await registry.execute({ name: "other", args: {} })
  expect((other.output as { spill?: unknown }).spill).toBeDefined() // the envelope branch IS live here
  const read = await registry.execute({ name: "read", args: {} })
  expect(read.output).toBe(big) // same object back — no { output, outputPaths, spill } envelope
  rmSync(root, { recursive: true, force: true })
})

it("gcSpillStore removes files older than maxAgeMs and trims to maxTotalBytes", async () => {
  const root = mkdir()
  for (let i = 0; i < 5; i++) {
    const p = join(root, `f${i}.log`)
    writeFileSync(p, "x".repeat(100))
    utimesSync(p, new Date(Date.now() - 10_000_000), new Date(Date.now() - 10_000_000)) // 老 2×maxAgeMs
  }
  const old = await gcSpillStore(root, { maxAgeMs: 1_000_000, maxTotalBytes: 1_000_000 })
  expect(old.removedFiles).toBe(5)
  // 新鮮檔案 + 總量修剪（最舊先刪）
  for (let i = 0; i < 5; i++) {
    const p = join(root, `fresh${i}.log`)
    writeFileSync(p, "y".repeat(100))
    utimesSync(p, new Date(Date.now() - i * 1000), new Date(Date.now() - i * 1000))
  }
  const trimmed = await gcSpillStore(root, { maxAgeMs: 60_000, maxTotalBytes: 150 })
  expect(trimmed.removedFiles).toBe(4) // 剩 1 個
  rmSync(root, { recursive: true, force: true })
})
