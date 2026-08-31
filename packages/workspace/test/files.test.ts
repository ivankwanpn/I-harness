import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listWorkspaceFiles } from "../src/files.ts"

/** Tree used by most tests: files + dirs at two levels. */
async function makeTree(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-files-"))
  await mkdir(join(root, "src", "lib"), { recursive: true })
  await writeFile(join(root, "README.md"), "hi")
  await writeFile(join(root, "src", "main.ts"), "x")
  await writeFile(join(root, "src", "lib", "api.ts"), "y")
  return { root }
}

describe("listWorkspaceFiles (task 5.4b)", () => {
  it("lists files and directories with workspace-relative '/'-separated paths + names", async () => {
    const { root } = await makeTree()
    try {
      const files = await listWorkspaceFiles(root, "")
      // Deterministic (codepoint per level): README.md, src, src/lib, src/lib/api.ts, src/main.ts
      expect(files).toEqual([
        { path: "README.md", name: "README.md", type: "file" },
        { path: "src", name: "src", type: "dir" },
        { path: "src/lib", name: "lib", type: "dir" },
        { path: "src/lib/api.ts", name: "api.ts", type: "file" },
        { path: "src/main.ts", name: "main.ts", type: "file" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("skips node_modules / .git / .i-harness / dist at any depth", async () => {
    const { root } = await makeTree()
    try {
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
      await writeFile(join(root, "node_modules", "pkg", "index.js"), "x")
      await mkdir(join(root, ".git"), { recursive: true })
      await writeFile(join(root, ".git", "HEAD"), "ref")
      await mkdir(join(root, ".i-harness"), { recursive: true })
      await writeFile(join(root, ".i-harness", "x.json"), "{}")
      await mkdir(join(root, "dist"), { recursive: true })
      await writeFile(join(root, "dist", "app.js"), "x")
      await mkdir(join(root, "src", "dist"), { recursive: true }) // nested skip too
      await writeFile(join(root, "src", "dist", "b.js"), "x")

      const files = await listWorkspaceFiles(root, "")
      const paths = files.map(f => f.path)
      expect(paths).not.toContain("node_modules")
      expect(paths).not.toContain("node_modules/pkg")
      expect(paths).not.toContain("node_modules/pkg/index.js")
      expect(paths).not.toContain("src/dist")
      expect(paths).not.toContain("src/dist/b.js")
      expect(paths.some(p => p.startsWith(".git"))).toBe(false)
      expect(paths.some(p => p.startsWith(".i-harness"))).toBe(false)
      expect(paths.some(p => p.startsWith("dist"))).toBe(false)
      // A non-skipped sibling at the same depth is still there.
      expect(paths).toContain("src/main.ts")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("matches by case-insensitive path substring (and still descends into non-matching dirs)", async () => {
    const { root } = await makeTree()
    try {
      await writeFile(join(root, "src", "lib", "UPPER.TS"), "x")
      // Substring on the whole path, case-insensitive: "upper" hits the file
      // name INSIDE "src" — a dir whose own path does not match the needle.
      expect((await listWorkspaceFiles(root, "upper")).map(f => f.path)).toEqual(["src/lib/UPPER.TS"])
      const api = (await listWorkspaceFiles(root, "src")).map(f => f.path)
      expect(api).toContain("src")
      expect(api).toContain("src/lib/api.ts")
      // An unmatched needle answers an honest empty list.
      expect(await listWorkspaceFiles(root, "zzz-nothing")).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("cap: maxEntries stops the walk early and answers only the collected prefix", async () => {
    const { root } = await makeTree()
    try {
      for (let i = 0; i < 20; i += 1) await writeFile(join(root, `f${String(i).padStart(2, "0")}.ts`), "x")
      const files = await listWorkspaceFiles(root, "", { maxEntries: 3 })
      expect(files).toHaveLength(3)
      // The paused prefix is deterministic: README.md, f00.ts, f01.ts.
      expect(files.map(f => f.path)).toEqual(["README.md", "f00.ts", "f01.ts"])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("cap: maxDepth bounds directory levels entered", async () => {
    const { root } = await makeTree()
    try {
      await mkdir(join(root, "a", "b", "c"), { recursive: true })
      await writeFile(join(root, "a", "b", "c", "deep.ts"), "x")
      const depth2 = await listWorkspaceFiles(root, "", { maxDepth: 1 })
      const paths = depth2.map(f => f.path)
      expect(paths).toContain("a")
      expect(paths).toContain("a/b")
      expect(paths).not.toContain("a/b/c")
      expect(paths).not.toContain("a/b/c/deep.ts")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("cap: maxVisited bounds the examined entries (work bound on huge trees)", async () => {
    const { root } = await makeTree()
    try {
      for (let i = 0; i < 30; i += 1) await writeFile(join(root, `k${i}.ts`), "x")
      const files = await listWorkspaceFiles(root, "", { maxVisited: 5 })
      // Codepoint order: README.md, k0.ts, k1.ts, k10.ts, k11.ts (k10 < k2).
      expect(files.map(f => f.path)).toEqual(["README.md", "k0.ts", "k1.ts", "k10.ts", "k11.ts"])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("does not follow symlinks (a link cannot drag the walk outside the workspace)", async () => {
    const { root } = await makeTree()
    const outside = join(tmpdir(), `i-harness-outside-${Date.now()}`)
    try {
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, "secret.ts"), "x")
      let linked: boolean
      try {
        await symlink(outside, join(root, "link-out"))
        linked = true
      } catch {
        linked = false // Windows without developer mode: no symlink privilege — skip
      }
      if (!linked) return
      const files = await listWorkspaceFiles(root, "")
      expect(files.map(f => f.path)).not.toContain("link-out")
      expect(files.some(f => f.path.includes("secret.ts"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
      await rm(outside, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("an unreadable/missing ROOT throws (loud — never a silent empty result)", async () => {
    await expect(listWorkspaceFiles(join(tmpdir(), "i-harness-absent-root"), "")).rejects.toThrow()
  })
})
