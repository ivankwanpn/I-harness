import { describe, expect, it, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createExecService, type ExecCommand, type ExecService } from "@i-harness/exec"
import { createFsSearchTools, resolveRgPath } from "../src/index.ts"

// D1 (m55-shell): a recording exec service — asserts the cwd handed to rg.
function recordingExec(calls: ExecCommand[]): ExecService {
  return {
    run: async (cmd) => {
      calls.push(cmd)
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false }
    },
    runBackground: () => ({ jobId: "none" }),
    getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }
}

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

  it("marks both tools isConcurrencySafe", () => {
    const [glob, grep] = createFsSearchTools({ exec: createExecService() })
    expect(glob.isConcurrencySafe).toBe(true)
    expect(grep.isConcurrencySafe).toBe(true)
  })

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

describe("fs-search workspace-bound search root (D1)", () => {
  it("glob defaults its search root to the workspace when no path is given", async () => {
    const calls: ExecCommand[] = []
    const [glob] = createFsSearchTools({ exec: recordingExec(calls), workspace: "/ws" })
    await (glob as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "**/*.ts" }, {})
    expect(calls[0]!.cwd).toBe("/ws")
  })

  it("glob keeps an explicit path as the search root", async () => {
    const calls: ExecCommand[] = []
    const [glob] = createFsSearchTools({ exec: recordingExec(calls), workspace: "/ws" })
    await (glob as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "**/*.ts", path: "/other" }, {})
    expect(calls[0]!.cwd).toBe("/other")
  })

  it("glob resolves a relative explicit path against the workspace", async () => {
    const calls: ExecCommand[] = []
    const [glob] = createFsSearchTools({ exec: recordingExec(calls), workspace: "/ws" })
    await (glob as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "**/*.ts", path: "sub" }, {})
    expect(calls[0]!.cwd).toBe(resolve("/ws", "sub"))
  })

  it("grep runs in the workspace (omitted/relative paths resolve there)", async () => {
    const calls: ExecCommand[] = []
    const [, grep] = createFsSearchTools({ exec: recordingExec(calls), workspace: "/ws" })
    await (grep as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "x" }, {})
    await (grep as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "x", path: "sub" }, {})
    expect(calls.map((c) => c.cwd)).toEqual(["/ws", "/ws"])
  })

  it("no workspace configured → no cwd field (exec's own contract: process cwd)", async () => {
    const calls: ExecCommand[] = []
    const [glob, grep] = createFsSearchTools({ exec: recordingExec(calls) })
    await (glob as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "**/*.ts" }, {})
    await (grep as { execute(a: unknown, e: unknown): Promise<unknown> }).execute({ pattern: "x" }, {})
    expect(calls[0]!.cwd).toBeUndefined()
    expect(calls[1]!.cwd).toBeUndefined()
  })

  it("real rg: glob finds files in the workspace without a path arg", async () => {
    if (!rgAvailable) return
    const dir = setupDir()
    try {
      const [glob] = createFsSearchTools({ exec: createExecService(), workspace: dir })
      const result = await (glob as { execute(a: unknown, e: unknown): Promise<{ matches: string[]; error?: string }> }).execute(
        { pattern: "**/*.txt" },
        {},
      )
      const matches = result.matches.map((m) => m.replace(/\\/g, "/"))
      expect(matches).toContain("a.txt")
      expect(matches).toContain("sub/c.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("real rg: grep finds matches in the workspace without a path arg", async () => {
    if (!rgAvailable) return
    const dir = mkdtempSync(join(tmpdir(), "fs-search-ws-"))
    // Unique marker: must NOT appear anywhere in the process cwd, otherwise the
    // pre-fix (process-cwd) behavior would pass by accident.
    const marker = `ws-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`
    writeFileSync(join(dir, "m.txt"), `${marker}\n`)
    try {
      const [, grep] = createFsSearchTools({ exec: createExecService(), workspace: dir })
      const result = await (grep as { execute(a: unknown, e: unknown): Promise<{ matches: { text: string }[]; error?: string }> }).execute(
        { pattern: marker },
        {},
      )
      expect(result.error).toBeUndefined()
      expect(result.matches.length).toBe(1)
      expect(result.matches[0]!.text).toContain(marker)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
