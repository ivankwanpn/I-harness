import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import {
  createToolRegistry,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_MID_FLIGHT,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
  TOOL_TIMEOUT,
  type Tool,
} from "@i-harness/core-tools"
import { createOutputSpillGuard, gcSpillStore } from "../src/spill-guard.ts"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
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
  // The cap must leave room for the notice, which is charged INSIDE it (a
  // 100-byte cap can no longer hold any replacement at all — see the
  // "keeps the original when no replacement fits" test below).
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
  const result = await registry.execute({ name: "big", args: {} })
  const out = result.output as string
  expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2_000)
  expect(out).toContain("Full result stored at:")
  expect(out).toContain("A") // retained tail
  const path = /Full result stored at: (.+?)\. Use grep/.exec(out)![1]
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
  registry.register({ name: "obj", description: "", inputSchema: {}, execute: async () => ({ blob: "B".repeat(20_000) }) } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
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
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
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
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
  const other = await registry.execute({ name: "other", args: {} })
  expect((other.output as { spill?: unknown }).spill).toBeDefined() // the envelope branch IS live here
  const read = await registry.execute({ name: "read", args: {} })
  expect(read.output).toBe(big) // same object back — no { output, outputPaths, spill } envelope
  rmSync(root, { recursive: true, force: true })
})

// ── the synthetic-failure exemption ─────────────────────────────────────────
// A synthetic failure is a VERDICT ABOUT a call, not output FROM it. Each test
// below drives ONE code from the vocabulary (`core-tools` owns the contract)
// beside a control that has the SAME shape and NO code, in the same registry at
// the same cap. The control is the witness: it proves a replacement was
// available at this cap, so "untouched" cannot be reached by the guard doing
// nothing, and a predicate keyed on the SHAPE would have to bound both.
async function driveSynthetic(code: string): Promise<{
  synthetic: unknown
  control: unknown
  fixture: { error: string; note: string }
}> {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const fixture = { error: "the call's own reason", note: "N".repeat(10_000) }
  registry.register({ name: "synthetic", description: "", inputSchema: {}, execute: async () => ({ ...fixture, code }) } as Tool)
  registry.register({ name: "control", description: "", inputSchema: {}, execute: async () => fixture } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
  const control = await registry.execute({ name: "control", args: {} })
  const synthetic = await registry.execute({ name: "synthetic", args: {} })
  rmSync(root, { recursive: true, force: true })
  return { synthetic: synthetic.output, control: control.output, fixture }
}

it("a synthetic TOOL_FAILED result is never bounded — the reason the call failed survives", async () => {
  const { synthetic, control, fixture } = await driveSynthetic(TOOL_FAILED)
  // The witness: this fixture shape is bounded when it carries no code.
  expect((control as { spill?: unknown }).spill).toBeDefined()
  expect(synthetic).toEqual({ ...fixture, code: TOOL_FAILED })
})

it("a synthetic TOOL_ABORTED_BEFORE_DISPATCH result is never bounded", async () => {
  const { synthetic, control, fixture } = await driveSynthetic(TOOL_ABORTED_BEFORE_DISPATCH)
  expect((control as { spill?: unknown }).spill).toBeDefined()
  expect(synthetic).toEqual({ ...fixture, code: TOOL_ABORTED_BEFORE_DISPATCH })
})

it("a synthetic TOOL_CANCELLED_BY_SIBLING result is never bounded", async () => {
  const { synthetic, control, fixture } = await driveSynthetic(TOOL_CANCELLED_BY_SIBLING)
  expect((control as { spill?: unknown }).spill).toBeDefined()
  expect(synthetic).toEqual({ ...fixture, code: TOOL_CANCELLED_BY_SIBLING })
})

it("a synthetic TOOL_ABORTED_MID_FLIGHT result is never bounded", async () => {
  const { synthetic, control, fixture } = await driveSynthetic(TOOL_ABORTED_MID_FLIGHT)
  expect((control as { spill?: unknown }).spill).toBeDefined()
  expect(synthetic).toEqual({ ...fixture, code: TOOL_ABORTED_MID_FLIGHT })
})

it("a synthetic TOOL_TIMEOUT result is never bounded — the only code that crosses this seam", async () => {
  const { synthetic, control, fixture } = await driveSynthetic(TOOL_TIMEOUT)
  expect((control as { spill?: unknown }).spill).toBeDefined()
  expect(synthetic).toEqual({ ...fixture, code: TOOL_TIMEOUT })
})

it("never emits a replacement larger than the cap — the notice counts against it", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const big = "A".repeat(10_000)
  registry.register({ name: "big", description: "", inputSchema: {}, execute: async () => big } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
  const result = await registry.execute({ name: "big", args: {} })
  const out = result.output as string
  expect(out).not.toBe(big) // it IS a replacement, not the untouched original ...
  expect(out).toContain("Full result stored at:")
  expect(out).toContain("A")
  // ... and the notice's own bytes are charged INSIDE the cap. The raw byte
  // length is the rule as written; the JSON-quoted length is what
  // `toolResultText` actually hands the model for a string result, so it is the
  // stronger of the two and the one the guard must keep.
  expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2_000)
  expect(Buffer.byteLength(JSON.stringify(out), "utf-8")).toBeLessThanOrEqual(2_000)
  rmSync(root, { recursive: true, force: true })
})

it("keeps the original when no replacement fits — it never emits something larger than what it replaced", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const original = "A".repeat(51) // ONE byte over a 50-byte cap
  registry.register({ name: "barely", description: "", inputSchema: {}, execute: async () => original } as Tool)
  // The notice alone is ~200 bytes (its fixed text plus this spill path), so a
  // 50-byte cap cannot hold ANY replacement: assembling one would enlarge a
  // 51-byte result several times over. The original must come back untouched.
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 50, spillRoot: root }))
  const result = await registry.execute({ name: "barely", args: {} })
  expect(result.output).toBe(original)
  rmSync(root, { recursive: true, force: true })
})

it("an image result whose MODEL-VISIBLE text fits is not spilled — 100 KiB of base64 is a ~40-byte descriptor", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  // The `read_image` shape (packages/attachment/src/read-image.ts): inline
  // base64, 10 MiB by default. 100 KiB of it is ~136 KB of JSON — well over the
  // SHIPPED 64_000-byte default — but the model never sees those bytes as text:
  // `toolResultText` strips the array and hands over a short descriptor, and
  // the bytes ride as image parts.
  const image = { mediaType: "image/png", dataBase64: "A".repeat(100_000) }
  registry.register({ name: "read_image", description: "", inputSchema: {}, execute: async () => ({ images: [image] }) } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { spillRoot: root })) // the shipped default cap
  const result = await registry.execute({ name: "read_image", args: {} })
  expect(result.output).toEqual({ images: [image] }) // untouched — the picture reaches the model
  expect(readdirSync(root)).toEqual([]) // and nothing was spilled
  rmSync(root, { recursive: true, force: true })
})

it("a spilled object replacement still carries a real `images` array, and the cap measures the whole envelope", async () => {
  const root = mkdir()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const image = { mediaType: "image/png", dataBase64: "A".repeat(400) }
  const payload = { note: "N".repeat(10_000), images: [image] } // oversized TEXT beside a real image
  registry.register({ name: "shot", description: "", inputSchema: {}, execute: async () => payload } as Tool)
  ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
  const result = await registry.execute({ name: "shot", args: {} })
  const out = result.output as { output: string; outputPaths: string[]; spill: { omittedBytes: number }; images?: unknown }
  expect(out.spill.omittedBytes).toBeGreaterThan(5_000) // the text WAS bounded ...
  expect(out.images).toEqual([image]) // ... and the picture rides the replacement
  // What the model sees for this replacement is the WHOLE envelope stringified
  // (the authority's rule), with the images counted at descriptor size:
  const descriptor = `\nimage: unnamed ?x? ${Math.ceil((image.dataBase64.length * 3) / 4)}B base64:${image.dataBase64.slice(0, 8)}`
  const visible = JSON.stringify({ output: out.output, outputPaths: out.outputPaths, spill: out.spill }) + descriptor
  expect(Buffer.byteLength(visible, "utf-8")).toBeLessThanOrEqual(2_000)
  // The base64 is not text: it must not come back as a wall of it in `output`,
  // and the durable copy holds the same text (a wall of base64 is no more
  // readable in a file than it was in the prompt).
  expect(out.output).not.toContain(image.dataBase64.slice(0, 40))
  expect(readFileSync(out.outputPaths![0], "utf-8")).not.toContain(image.dataBase64.slice(0, 40))
  rmSync(root, { recursive: true, force: true })
})

it("still emits a replacement when JSON escaping blows the first round past 2× the cap", async () => {
  // The fit loop subtracts the overage the MEASURE reports, but the retainer
  // budget is RAW bytes. With escape-heavy text (a quote is 1 byte / 2 escaped;
  // a NUL is 1 byte / 6 escaped) round one measures past 2× the cap, a plain
  // subtraction lands below 1, the loop gives up and the ORIGINAL comes back —
  // over the cap and with no notice. Each row below is over 2× cap on round
  // one, measured at 20,002 / 60,002 / 20,014 model-visible bytes.
  const rows: Array<[string, unknown]> = [
    ["quote-heavy string", `"`.repeat(10_000)],
    ["NUL-heavy string", "\u0000".repeat(10_000)],
    ["quote-heavy object", { content: `"`.repeat(10_000) }],
  ]
  for (const [label, value] of rows) {
    const root = mkdir()
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register({ name: "esc", description: "", inputSchema: {}, execute: async () => value } as Tool)
    ctx.mount(createOutputSpillGuard(ctx, { maxOutputBytes: 2_000, spillRoot: root }))
    const result = await registry.execute({ name: "esc", args: {} })
    // These fixtures carry no `images`, so what the model sees is the result
    // stringified whole (the string branch's JSON-quoted form included).
    const visible = Buffer.byteLength(JSON.stringify(result.output), "utf-8")
    expect(visible, label).toBeLessThanOrEqual(2_000)
    rmSync(root, { recursive: true, force: true })
  }
})

it("the fit loop reaches a fit across the whole failing band (string branch, shipped cap)", async () => {
  // The band the earlier fit fix did not close. The loop shrank the budget by
  // the overage it MEASURED, but the budget is RAW bytes and the measure is the
  // JSON-ESCAPED one — so while the retainer still keeps the whole string, the
  // subtraction moves the budget and NOT the candidate: the same overage comes
  // back every round and eight rounds can end with the ORIGINAL returned, over
  // the cap, spill file written. Measured on the pre-fix tree at the shipped
  // 64,000 cap: the quote rows below came back at up to 68,402 model-visible
  // bytes and the NUL rows at up to 70,502. A fit demonstrably exists — a binary
  // search for the largest fitting budget finds 31,930 and 10,643 — so "no
  // replacement fits" was false for every row here.
  //
  // String branch only, and the rows are built from a string literal: no
  // IN-TREE tool returns a bare string result today, so the band's reachability
  // is a plugin-provided tool that does. The band is real; its producer is the
  // shape a plugin can still hand over.
  const rows: Array<[string, string]> = []
  for (let n = 32_000; n <= 34_200; n += 100) rows.push([`${n} quotes`, `"`.repeat(n)])
  for (let n = 11_000; n <= 11_900; n += 100) rows.push([`${n} NULs`, "\u0000".repeat(n)])
  for (const [label, value] of rows) {
    const root = mkdir()
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register({ name: "esc", description: "", inputSchema: {}, execute: async () => value } as Tool)
    ctx.mount(createOutputSpillGuard(ctx, { spillRoot: root })) // the shipped cap: 64,000
    const result = await registry.execute({ name: "esc", args: {} })
    const out = result.output as string
    // A REPLACEMENT, not the give-up: the give-up is the defect this pins.
    expect(out, label).not.toBe(value)
    expect(Buffer.byteLength(JSON.stringify(out), "utf-8"), label).toBeLessThanOrEqual(64_000)
    rmSync(root, { recursive: true, force: true })
  }
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
