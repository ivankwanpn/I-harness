import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import type { TextDiff } from "@i-harness/text-diff"
import { createFsTools, resolvePath } from "../src/index.ts"

describe("fs tools", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-fs-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("read reads a file", async () => {
    writeFileSync(join(dir, "a.txt"), "hello")
    const tools = createFsTools({ workspace: dir })
    const read = tools.find((t) => t.name === "read")!
    const result = (await read.execute({ path: "a.txt" }, {})) as { content: string }
    expect(result.content).toBe("hello")
  })

  it("write writes a file", async () => {
    const tools = createFsTools({ workspace: dir })
    const write = tools.find((t) => t.name === "write")!
    await write.execute({ path: "b.txt", text: "world" }, {})
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("world")
  })

  it("list_dir lists a directory", async () => {
    writeFileSync(join(dir, "a.txt"), "")
    mkdirSync(join(dir, "sub"))
    const tools = createFsTools({ workspace: dir })
    const list = tools.find((t) => t.name === "list_dir")!
    const result = (await list.execute({ path: "." }, {})) as { entries: string[] }
    expect(result.entries).toContain("a.txt")
    expect(result.entries).toContain("sub")
  })

  it("marks read/list_dir as isReadOnly and write as not", () => {
    const tools = createFsTools({ workspace: dir })
    expect(tools.find((t) => t.name === "read")!.isReadOnly).toBe(true)
    expect(tools.find((t) => t.name === "list_dir")!.isReadOnly).toBe(true)
    expect(tools.find((t) => t.name === "write")!.isReadOnly).toBe(false)
  })

  it("marks read-only tools isConcurrencySafe", () => {
    const tools = createFsTools({ workspace: process.cwd() })
    const read = tools.find((t) => t.name === "read")!
    const list = tools.find((t) => t.name === "list_dir")!
    const write = tools.find((t) => t.name === "write")!
    expect(read.isConcurrencySafe).toBe(true)
    expect(list.isConcurrencySafe).toBe(true)
    expect(write.isConcurrencySafe).toBeUndefined()
  })

  it("resolvePath resolves relative paths inside the workspace", () => {
    expect(resolvePath(dir, "a.txt")).toBe(join(dir, "a.txt"))
    expect(resolvePath(dir, "sub/b.txt")).toBe(join(dir, "sub", "b.txt"))
  })

  it("resolvePath rejects .. escape (fail-closed)", () => {
    expect(() => resolvePath(dir, "../outside.txt")).toThrow(/escapes workspace/)
    expect(() => resolvePath(dir, "sub/../../outside.txt")).toThrow(/escapes workspace/)
  })
  it("resolvePath still allows absolute inputs (M1 behavior)", () => {
    // 絕對路徑原樣允許（read 可用於 workspace 外；containment 只擋相對 .. 逃逸）
    expect(resolvePath(dir, dir)).toBe(dir)
  })
})

describe("structured change results (M49)", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-fs-diff-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const tools = () => createFsTools({ workspace: dir })

  it("edit returns a structured change generated from actual before/after text", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8")
    const edit = tools().find((tool) => tool.name === "edit")!
    const out = (await edit.execute({ path: "a.txt", old_string: "two", new_string: "TWO" }, {})) as { change: TextDiff }
    expect(out.change).toMatchObject({
      path: "a.txt",
      added: 1,
      deleted: 1,
      hunks: [expect.objectContaining({ oldStart: 1, newStart: 1 })],
    })
  })

  it("edit result keeps all existing fields alongside the change", async () => {
    await writeFile(join(dir, "b.txt"), "foo bar", "utf8")
    const edit = tools().find((tool) => tool.name === "edit")!
    const out = (await edit.execute({ path: "b.txt", old_string: "bar", new_string: "baz" }, {})) as {
      ok: boolean
      path: string
      replacements: number
      change?: TextDiff
    }
    expect(out).toMatchObject({ ok: true, path: "b.txt", replacements: 1 })
    expect(out.change?.added).toBe(1)
    expect(out.change?.deleted).toBe(1)
    expect(out.change?.truncated).toBe(false)
  })

  async function runApplyPatchFixture(): Promise<{
    ok: boolean
    applied: Array<{ path: string; action: string }>
    errors: Array<{ path: string; message: string }>
    rawPatch?: string
    change?: TextDiff
  }> {
    const apply = tools().find((tool) => tool.name === "apply_patch")!
    return apply.execute(
      { patch_content: "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch\n" },
      {},
    ) as Promise<{
      ok: boolean
      applied: Array<{ path: string; action: string }>
      errors: Array<{ path: string; message: string }>
      rawPatch?: string
      change?: TextDiff
    }>
  }

  it("apply_patch preserves a raw patch fallback when a structured change cannot be built", async () => {
    const out = await runApplyPatchFixture()
    expect(out).toMatchObject({ applied: expect.any(Array) })
    expect(out.rawPatch ?? out.change).toBeDefined()
    expect(out.rawPatch).toContain("*** Begin Patch")
  })

  it("apply_patch exposes the per-file change for an update hunk", async () => {
    await writeFile(join(dir, "u.txt"), "old\n", "utf8")
    const apply = tools().find((tool) => tool.name === "apply_patch")!
    const out = (await apply.execute(
      { patch_content: "*** Begin Patch\n*** Update File: u.txt\n@@\n-old\n+new\n*** End Patch\n" },
      {},
    )) as { ok: boolean; change?: TextDiff; rawPatch?: string }
    expect(out.ok).toBe(true)
    expect(out.change).toMatchObject({ path: "u.txt", added: 1, deleted: 1 })
    expect(out.rawPatch).toBeUndefined()
  })
})
