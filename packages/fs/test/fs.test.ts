import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
