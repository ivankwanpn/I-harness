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
  it("normalizes CRLF patch_content (\r not treated as line content)", async () => {
    // Regression (M21 final-review Fix 3)：patch 內容帶 CRLF 時，parsePatch 曾把
    // \r 當行內容 → Add 寫入字面 \r、Update 誤報 FS_EDIT_NOT_FOUND。正規化成
    // LF 後：ok:true 且檔案內容為 LF 結尾。
    const out = (await tool().execute({
      patch_content: "*** Begin Patch\r\n*** Add File: new.txt\r\n+hi\r\n*** End Patch\r\n",
    }, {})) as { ok: boolean }
    expect(out.ok).toBe(true)
    const content = await readFile(join(dir, "new.txt"), "utf-8")
    expect(content).toBe("hi\n")
    expect(content).not.toContain("\r")
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
  it("applies replacements by document order when pure-append precedes replace (regression)", async () => {
    // 合法補丁：純插入 chunk（+X，落檔尾）在文件序上先出現，後面才是指向較早行的 replace。
    // 記錄序＝[append(idx2), replace(idx0)] ≠ 文件序 → 未排序直接倒序會把 X 插到 A1/A2 與 b 之間。
    await writeFile(join(dir, "a.txt"), "a\nb\n")
    const out = (await tool().execute({
      patch_content: `*** Begin Patch\n*** Update File: a.txt\n@@\n+X\n*** End of File\n@@\n-a\n+A1\n+A2\n*** End Patch\n`,
    }, {})) as { ok: boolean }
    expect(out.ok).toBe(true)
    const content = await readFile(join(dir, "a.txt"), "utf-8")
    expect(content).toBe("A1\nA2\nb\nX\n")
    expect(content).not.toBe("A1\nA2\nX\nb\n") // 原錯誤結果（静默損壞）不得復發
  })
  it("rejects *** Add File: on an existing file without overwriting (fail-closed)", async () => {
    await writeFile(join(dir, "new.txt"), "original")
    const out = (await tool().execute({ patch_content: PATCH_ADD }, {})) as { ok: boolean; errors: { path: string; message: string }[] }
    expect(out.ok).toBe(false)
    expect(out.errors.some((e) => e.path === "new.txt")).toBe(true)
    expect(out.errors[0]?.message).toMatch(/already exists/i)
    expect(await readFile(join(dir, "new.txt"), "utf-8")).toBe("original") // 內容未被覆寫
  })
  it("@@ <context> seeks forward past an earlier match of oldLines (cursor-advance)", async () => {
    // 檔案 `old\nheader\nold\n`：oldLines 的 `old` 在 anchor `header`「之前」也
    // 出現過——cursor 只前進 + 先定位 context 再找 oldLines，保證只替換 header
    // 「之後」那個 old；若回歸成從檔頭搜尋，第一個 old 會被錯誤改寫。
    await writeFile(join(dir, "a.txt"), "old\nheader\nold\n")
    const out = (await tool().execute({
      patch_content: "*** Begin Patch\n*** Update File: a.txt\n@@ header\n-old\n+new\n*** End Patch\n",
    }, {})) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("old\nheader\nnew\n")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).not.toBe("new\nheader\nold\n") // 錯位結果不得復發
  })
})
