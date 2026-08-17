import { describe, expect, it, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecService } from "@i-harness/exec"
import { createFsSearchTools, resolveRgPath } from "../src/index.ts"

// Skip if the packaged ripgrep binary cannot resolve (e.g. partial install).
let rgAvailable = true
beforeAll(async () => {
  try { await resolveRgPath() } catch { rgAvailable = false }
})

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), "fs-search-"))
  writeFileSync(join(dir, "a.txt"), "hello world\n")
  writeFileSync(join(dir, "b.md"), "nothing here\n")
  mkdirSync(join(dir, "sub"))
  writeFileSync(join(dir, "sub", "c.txt"), "find me here\n")
  return dir
}

describe("fs-search glob", () => {
  it("finds files matching a glob pattern", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [glob] = createFsSearchTools({ exec: createExecService() })
      const result = await (glob as { execute(a: unknown, e: unknown): Promise<{ matches: string[] }> }).execute(
        { pattern: "**/*.txt", path: dir },
        {},
      )
      const matches = result.matches.map((m) => m.replace(/\\/g, "/"))
      expect(matches).toContain("a.txt")
      expect(matches).toContain("sub/c.txt")
      expect(matches).not.toContain("b.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("returns empty matches (not an error) when no file matches", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [glob] = createFsSearchTools({ exec: createExecService() })
      const result = await (glob as { execute(a: unknown, e: unknown): Promise<{ matches: string[]; error?: string }> }).execute(
        { pattern: "**/*.rs", path: dir },
        {},
      )
      expect(result.matches).toEqual([])
      expect(result.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("reports an error when the search path does not exist", async () => {
    if (!rgAvailable) return
    const missingDir = join(tmpdir(), `fs-search-missing-${Date.now()}`)
    const [glob] = createFsSearchTools({ exec: createExecService() })
    const result = await (glob as { execute(a: unknown, e: unknown): Promise<{ matches: string[]; error?: string }> }).execute(
      { pattern: "**/*.txt", path: missingDir },
      {},
    )
    expect(result.matches).toEqual([])
    expect(result.error).toBeTruthy()
  }, 20_000)
})

describe("fs-search grep", () => {
  it("finds matching lines with path, line number, and text", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [, grep] = createFsSearchTools({ exec: createExecService() })
      const result = await (grep as { execute(a: unknown, e: unknown): Promise<{ matches: { path: string; line: number; text: string }[] }> }).execute(
        { pattern: "hello", path: dir },
        {},
      )
      expect(result.matches.length).toBeGreaterThan(0)
      const first = result.matches[0]!
      expect(first.text).toContain("hello")
      expect(first.line).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("returns empty matches (not an error) when the pattern is absent", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [, grep] = createFsSearchTools({ exec: createExecService() })
      const result = await (grep as { execute(a: unknown, e: unknown): Promise<{ matches: { path: string; line: number; text: string }[]; error?: string }> }).execute(
        { pattern: "zzzabsent", path: dir },
        {},
      )
      expect(result.matches).toEqual([])
      expect(result.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("reports an error for an invalid regex pattern", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [, grep] = createFsSearchTools({ exec: createExecService() })
      const result = await (grep as { execute(a: unknown, e: unknown): Promise<{ matches: { path: string; line: number; text: string }[]; error?: string }> }).execute(
        { pattern: "[", path: dir },
        {},
      )
      expect(result.matches).toEqual([])
      expect(result.error).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
