import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadState, saveState } from "../src/state.ts"

describe("plugin state", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pg-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("missing file → default state (no throw, warns)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = await loadState(dir)
      expect(s.version).toBe(1)
      expect(s.sources).toEqual([])
      expect(s.plugins).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("corrupt JSON → rebuild default + warn", async () => {
    await writeFile(join(dir, "state.json"), "{not json", "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = await loadState(dir)
      expect(s.sources).toEqual([])
      expect(s.plugins).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("non-shape JSON (wrong version/shape) → rebuild default + warn", async () => {
    await writeFile(join(dir, "state.json"), JSON.stringify({ version: 99, sources: [], plugins: [] }), "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const s = await loadState(dir)
      expect(s.version).toBe(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("round-trip keeps state", async () => {
    const s = await loadState(dir)
    s.plugins.push({ id: "m__p", marketplace: "m", name: "p", installPath: "x", installed: true, enabled: true })
    await saveState(dir, s)
    const loaded = await loadState(dir)
    expect(loaded.plugins[0]).toEqual({
      id: "m__p",
      marketplace: "m",
      name: "p",
      installPath: "x",
      installed: true,
      enabled: true,
    })
    expect(loaded.version).toBe(1)
    expect(loaded.sources).toEqual([])
  })

  it("saveState creates the state directory (0700, best-effort) when missing", async () => {
    const nested = join(dir, "secret", "state")
    const s = await loadState(nested)
    await saveState(nested, s)
    expect(await loadState(nested)).toEqual({ version: 1, sources: [], plugins: [] })
  })
})
