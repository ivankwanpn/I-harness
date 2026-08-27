import { describe, expect, it, beforeEach } from "vitest"
import { createFsTools } from "../src/index.ts"
import { writeFile, readFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-edit-")) })
const tool = () => createFsTools({ workspace: dir }).find((t) => t.name === "edit")!

describe("edit tool", () => {
  it("replaces single occurrence and returns replacements", async () => {
    await writeFile(join(dir, "a.txt"), "foo bar baz")
    const out = (await tool().execute({ path: "a.txt", old_string: "bar", new_string: "QUX" }, {})) as { ok: boolean; replacements: number }
    expect(out.ok).toBe(true)
    expect(out.replacements).toBe(1)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("foo QUX baz")
  })
  it("rejects ambiguous (multiple, no replace_all)", async () => {
    await writeFile(join(dir, "a.txt"), "x y x")
    await expect(tool().execute({ path: "a.txt", old_string: "x", new_string: "z" }, {})).rejects.toThrow(/ambiguous/i)
  })
  it("replace_all replaces all", async () => {
    await writeFile(join(dir, "a.txt"), "x y x")
    const out = (await tool().execute({ path: "a.txt", old_string: "x", new_string: "z", replace_all: true }, {})) as { replacements: number }
    expect(out.replacements).toBe(2)
  })
  it("rejects not_found", async () => {
    await writeFile(join(dir, "a.txt"), "abc")
    await expect(tool().execute({ path: "a.txt", old_string: "zzz", new_string: "x" }, {})).rejects.toThrow(/not found/i)
  })
  it("rejects old === new (no-op)", async () => {
    await writeFile(join(dir, "a.txt"), "abc")
    await expect(tool().execute({ path: "a.txt", old_string: "a", new_string: "a" }, {})).rejects.toThrow()
  })
  it("preserves CRLF when editing CRLF file", async () => {
    await writeFile(join(dir, "a.txt"), "a\r\nb\r\nc")
    await tool().execute({ path: "a.txt", old_string: "b", new_string: "B" }, {})
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\r\nB\r\nc")
  })
  it("rejects file changed since read (stale)", async () => {
    await writeFile(join(dir, "a.txt"), "old content")
    // 先讀出 stat（模擬 read 觀察）→ 改名檔 → edit 帶 observedMtimeMs
    const { stat } = await import("node:fs/promises")
    const before = await stat(join(dir, "a.txt"))
    const observed = Math.floor(before.mtimeMs)
    // 變更檔（mtime 變化）
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, "a.txt"), "new content")
    await expect(tool().execute({ path: "a.txt", old_string: "old", new_string: "NEW", observedMtimeMs: observed }, {})).rejects.toThrow(/changed|stale/i)
  })
  it("rejects empty old_string (with and without replace_all), file unchanged", async () => {
    await writeFile(join(dir, "a.txt"), "abc")
    await expect(tool().execute({ path: "a.txt", old_string: "", new_string: "X" }, {})).rejects.toThrow(/empty|ambiguous/i)
    await expect(tool().execute({ path: "a.txt", old_string: "", new_string: "X", replace_all: true }, {})).rejects.toThrow(/empty|ambiguous/i)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("abc")
  })
})
