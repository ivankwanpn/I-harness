import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverInstructionPaths, loadInstructionFiles, renderInstructions, createInstructionsSection } from "../src/index.ts"

// Legacy discovery walks to the volume root. Keep this control wholly inside
// its synthetic fixture, including existence probes and default global roots.
const isolated = vi.hoisted(() => ({ root: '', home: '', actualProbes: [] as string[] }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => isolated.home }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, existsSync: (path: import('node:fs').PathLike) => {
    const value = String(path)
    if (!isolated.root || !(value === isolated.root || value.startsWith(isolated.root + '/') || value.startsWith(isolated.root + '\\'))) return false
    isolated.actualProbes.push(value)
    return actual.existsSync(path)
  } }
})

describe("instructions discovery", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-inst-"))
    isolated.root = root; isolated.home = join(root, 'fake-home'); isolated.actualProbes = []
  })
  afterEach(() => {
    expect(isolated.actualProbes.length).toBeGreaterThan(0)
    expect(isolated.actualProbes.every(path => path.startsWith(root + '/') || path.startsWith(root + '\\'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("walks workspace → parent → ancestor; AGENTS.md preferred over CLAUDE.md per dir", () => {
    const ws = join(root, "workspace")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(root, "AGENTS.md"), "root instructions")
    writeFileSync(join(ws, "CLAUDE.md"), "claude in workspace")
    writeFileSync(join(ws, "AGENTS.md"), "agents in workspace")
    const paths = discoverInstructionPaths(ws)
    // The guard above prevents foreign ancestor/home probes.
    const local = paths.filter((p) => p.startsWith(root))
    expect(local).toEqual([join(root, "AGENTS.md"), join(ws, "AGENTS.md")])
    expect(paths.indexOf(join(root, "AGENTS.md"))).toBeLessThan(paths.indexOf(join(ws, "AGENTS.md")))
    const files = loadInstructionFiles(ws)
    expect(files.map((f) => f.content)).toEqual(["root instructions", "agents in workspace"])
    const rendered = renderInstructions(files)
    expect(rendered.indexOf("root instructions")).toBeLessThan(rendered.indexOf("agents in workspace"))
  })

  it("prepends the global candidates (synthetic home override)", () => {
    const ws = join(root, "ws")
    const fakeHome = join(root, "fake-home")
    mkdirSync(ws, { recursive: true })
    mkdirSync(fakeHome, { recursive: true })
    writeFileSync(join(fakeHome, "CLAUDE.md"), "global instructions")
    writeFileSync(join(ws, "AGENTS.md"), "workspace instructions")
    const paths = discoverInstructionPaths(ws, fakeHome)
    expect(paths[0]).toBe(join(fakeHome, "CLAUDE.md"))
    expect(paths).toContain(join(ws, "AGENTS.md"))
  })

  it("returns a stable ordered list with no duplicates", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, "AGENTS.md"), "w")
    const paths = discoverInstructionPaths(ws)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths[paths.length - 1]).toBe(join(ws, "AGENTS.md"))
  })

  it("caches by mtime/size — changed content re-renders", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    const f = join(ws, "AGENTS.md")
    writeFileSync(f, "version one")
    const section = createInstructionsSection({ workspace: ws })
    expect(section()).toContain("version one")
    writeFileSync(f, "version two")
    // push mtime beyond the cached stat so the change is definitely detected
    utimesSync(f, new Date(), new Date(Date.now() + 2000))
    const second = section()
    expect(second).toContain("version two")
    expect(second).not.toContain("version one")
  })

  it("truncates the rendered set at maxBytes", () => {
    const ws = join(root, "ws")
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, "AGENTS.md"), "x".repeat(500))
    const section = createInstructionsSection({ workspace: ws, maxBytes: 100 })
    const out = section()
    expect(out.length).toBeLessThanOrEqual(100 + "(truncated)".length)
    expect(out.endsWith("(truncated)")).toBe(true)
  })
})
