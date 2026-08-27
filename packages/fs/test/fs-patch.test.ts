import { describe, expect, it, beforeEach } from "vitest"
import { createFsTools } from "../src/index.ts"
import { writeFile, readFile, access } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-patch-")) })
const tool = () => createFsTools({ workspace: dir }).find((t) => t.name === "apply_patch")!

const PATCH_ADD = `*** Begin Patch\n*** Add File: new.txt\n+hello\n+world\n*** End Patch\n`
const PATCH_UPDATE = `*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n`
const PATCH_DELETE = `*** Begin Patch\n*** Delete File: old.txt\n*** End Patch\n`

describe("apply_patch tool", () => {
  it("adds a file", async () => {
    const out = (await tool().execute({ patch_content: PATCH_ADD }, {})) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(await readFile(join(dir, "new.txt"), "utf-8")).toBe("hello\nworld\n")
  })
  it("updates with context", async () => {
    await writeFile(join(dir, "a.txt"), "a\nold\nb\n")
    const out = (await tool().execute({ patch_content: PATCH_UPDATE }, {})) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nnew\nb\n")
  })
  it("deletes a file", async () => {
    await writeFile(join(dir, "old.txt"), "bye")
    await tool().execute({ patch_content: PATCH_DELETE }, {})
    await expect(access(join(dir, "old.txt"))).rejects.toThrow()
  })
  it("multi-file batch works (single block)", async () => {
    // codex 格式：一個 patch = 一個 Begin/End 區塊內多個 hunks（不做兩個 Begin 區塊拼接）
    await writeFile(join(dir, "old.txt"), "bye")
    const patch = `*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: old.txt\n*** End Patch\n`
    const out = (await tool().execute({ patch_content: patch }, {})) as { ok: boolean; applied: unknown[]; errors: unknown[] }
    expect(out.ok).toBe(true)
    expect(out.applied).toHaveLength(2)
    expect(out.errors).toHaveLength(0)
  })
  it("reports context not found (ok:false, not throw)", async () => {
    await writeFile(join(dir, "a.txt"), "zzz\n")
    const out = (await tool().execute({ patch_content: PATCH_UPDATE }, {})) as { ok: boolean; errors: { path: string; message: string }[] }
    expect(out.ok).toBe(false)
    expect(out.errors[0]?.path).toBe("a.txt")
    expect(out.errors[0]?.message).toMatch(/not found|context/i)
  })
  it("rejects duplicate path in one patch (parse error throws)", async () => {
    const dup = `*** Begin Patch\n*** Add File: new.txt\n+x\n*** Update File: new.txt\n@@\n-x\n+y\n*** End Patch\n`
    await expect(tool().execute({ patch_content: dup }, {})).rejects.toThrow(/duplicate|already/i)
  })
  it("failed batch reports applied list and stops (ok:false)", async () => {
    // Add 成功後 Update 失敗（檔不存在）→ applied=[new.txt], errors=[a.txt]
    const patch = `*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n`
    const out = (await tool().execute({ patch_content: patch }, {})) as { ok: boolean; applied: unknown[]; errors: unknown[] }
    expect(out.ok).toBe(false)
    expect(out.applied.some((f) => (f as { path: string }).path === "new.txt")).toBe(true)
    expect(out.errors.some((e) => (e as { path: string }).path === "a.txt")).toBe(true)
  })
  it("rejects trailing content after *** End Patch (fail-closed)", async () => {
    const patch = `*** Begin Patch\n*** Add File: new.txt\n+x\n*** End Patch\n*** Add File: other.txt\n+y\n*** End Patch\n`
    await expect(tool().execute({ patch_content: patch }, {})).rejects.toThrow(/end patch|trailing/i)
  })
  it("supports *** End of File pure append (EOF marker AFTER + lines)", async () => {
    await writeFile(join(dir, "a.txt"), "first\n")
    await tool().execute({
      patch_content: `*** Begin Patch\n*** Update File: a.txt\n@@\n+last\n*** End of File\n*** End Patch\n`,
    }, {})
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("first\nlast\n")
  })
  it("rejects *** Move to: (fail-closed)", async () => {
    await writeFile(join(dir, "a.txt"), "x\n")
    await expect(tool().execute({
      patch_content: `*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch\n`,
    }, {})).rejects.toThrow(/Move to|not supported/i)
  })
})
