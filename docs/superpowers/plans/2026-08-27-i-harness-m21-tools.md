# M21 工具補齊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補齊 agent 日常作業核心工具——`edit`（literal search/replace）、`apply_patch`（codex 格式多檔批次 diff）、`todo_write`（whole-list session-scoped todo）、tool-output-spill-files（A 層 exec 串流 spill + B 層結果級 preview+notice）。

**Architecture:** 三子系統：(1) `@i-harness/fs` 擴充——`edit` + `apply_patch` 工具、`FsToolError`（機器碼）、`writeFileAtomic`、版本守衛（call 內 `{mtimeMs,size}` snapshot）、LF normalize + CRLF 還原、binary/UTF-8 拒絕；(2) 新 `@i-harness/todo`——`todo_write` 工具 + `deriveTodoList` 純函數 + core-session `todo/write` 事件（session-persistence `registerEventType`）；(3) `@i-harness/exec` + `output-retention`——A 層 exec 串流 `OutputCollector`（tail-keep + 首次 overflow 全量寫 + spill cap）、B 層 shell `retainedRunResult` 的 preview+notice。

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, node:fs/promises + node:path + node:crypto（均有）、node:tmpdir；無新外部依賴。dsh/codex 參考（吸收而非移植，見 `.superpowers/research/2026-08-27-m21-tools-applypatch-todo-research.md` 與 `2026-08-27-m21-tool-output-spill-research.md`）。

**Spec:** `docs/superpowers/specs/2026-08-26-i-harness-m20-m25-backend-complete-design.md`（§4 M21 工具補齊）

## Global Constraints

- 版本 `0.1.0`、ESM、strict TS（`strict`/`noUnusedLocals`/`noUnusedParameters`）、pnpm workspace
- 零新外部依賴（node builtins 與既有 deps）
- 平台：Windows 優先（測試主力）；Linux 順帶未測試
- fail-closed 紀律；`CURRENT_FORMAT_VERSION` 保持 1（additive only）
- 「吸收而非移植」：dsh/codex 代碼只作參考；無 `@deepseek-ai/*` imports；有缺陷/更好寫法則重寫
- 既有工具命名慣例：fs 工具用 `path`（非 dsh `file_path`）；JSON args（非 freeform）
- `tool/*` 事件不進 model-visible（deriveMessages 零修改）；todo 不進 FTS（deriveSearchText 零修改）
- `registerEventType` 必做（session-persistence module init，與 team/*、compaction/reset 同位）——不可只靠 `ignorable: true`（guardIgnorable 會 drop）

---

## Part 1: fs 擴充（edit + apply_patch + FsToolError + writeFileAtomic）

### Task 1: fs 基礎——FsToolError + writeFileAtomic + resolvePath 安全化 + 共用 helpers

**Files:**
- Create: `packages/fs/src/error.ts`
- Create: `packages/fs/src/atomic.ts`
- Create: `packages/fs/src/text.ts`（LF normalize + CRLF 還原 + binary/UTF-8 檢查）
- Modify: `packages/fs/src/index.ts`（resolvePath 加 containment 檢查；export 新 helpers）
- Test: `packages/fs/test/fs-atomic.test.ts`（新）、`packages/fs/test/fs-text.test.ts`（新）、`packages/fs/test/fs.test.ts`（修改——加 containment cases）

**Interfaces:**
- Consumes: `resolve`（node:path）、`readFile/writeFile/rename/mkdtemp`（node:fs/promises）、`Buffer`
- Produces:
  - `export type FsToolErrorCode = "FS_NOT_FOUND" | "FS_NOT_REGULAR_FILE" | "FS_EDIT_NOT_FOUND" | "FS_AMBIGUOUS_EDIT" | "FS_STALE_VERSION" | "FS_TOO_LARGE" | "FS_IO_ERROR"`
  - `export class FsToolError extends Error { readonly code: FsToolErrorCode; constructor(code, message) }`
  - `export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void>`（同目錄 temp + rename；mkdir parent recursive；temp 名 `.name.<randomBytes(6).hex>.tmp`）
  - `export function normalizeLineEndings(text: string): string`（CRLF → LF）
  - `export function detectLineEndings(text: string): "crlf" | "lf"`（前 4096 bytes 樣本；預設 lf）
  - `export function restoreLineEndings(text: string, style: "crlf" | "lf"): string`
  - `export function assertTextData(data: Uint8Array, maxBytes?: number): string`（NUL/binary 檢查 + UTF-8 TextDecoder({fatal}) + 大小上限）
  - `export function applyLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean): { text: string; replacements: number } | { error: "not_found" } | { error: "ambiguous"; count: number }`
  - `resolvePath` 增加 containment：`resolve(workspace, path)` 後用 `path.relative(workspace, resolved)` 檢查不以 `..` 開頭且不為絕對——超界 → throw `FsToolError("FS_NOT_FOUND", ...)`；絕對輸入（`C:\...`、`/...`）仍允許（M1 行為保持）

**Design note (binding):** `resolvePath` 的 containment 檢查是**新的 fail-closed** 行為——之前相對 `..` 可逃逸 workspace。**已驗證不破既有測試**：fs.test.ts 只測 workspace 內相對路徑（無 `..` 案例）；sandbox-windows-acl/attachment 各有自己的 resolve 邏輯（不用 fs 的 resolvePath）；CLI 僅以 `opts.workspace` 調用 createFsTools。**保留絕對輸入允許**（M1 行為）；只擋「相對於 workspace 的 `..` 逃逸」與「跨 drive/絕對化解析結果」。

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/fs/test/fs-atomic.test.ts
import { describe, expect, it } from "vitest"
import { writeFileAtomic } from "../src/atomic.ts"
import { readFile, stat } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("writeFileAtomic", () => {
  it("writes content atomically (no partial)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-atomic-"))
    const p = join(dir, "sub", "file.txt") // parent missing → mkdir recursive
    await writeFileAtomic(p, "hello")
    expect(await readFile(p, "utf-8")).toBe("hello")
    // no temp residue
    const entries = await import("node:fs/promises").then((m) => m.readdir(join(dir, "sub")))
    expect(entries).toEqual(["file.txt"])
  })
  it("overwrites existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-atomic-"))
    const p = join(dir, "f.txt")
    await writeFileAtomic(p, "one")
    await writeFileAtomic(p, "two")
    expect(await readFile(p, "utf-8")).toBe("two")
  })
})
```

```ts
// packages/fs/test/fs-text.test.ts
import { describe, expect, it } from "vitest"
import { normalizeLineEndings, detectLineEndings, restoreLineEndings, assertTextData, applyLiteralEdit } from "../src/text.ts"

describe("line endings", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\nc\r\nd")).toBe("a\nb\nc\nd")
  })
  it("detects CRLF from sample", () => {
    expect(detectLineEndings("a\r\nb\r\nc")).toBe("crlf")
    expect(detectLineEndings("a\nb\nc")).toBe("lf")
  })
  it("restores CRLF", () => {
    expect(restoreLineEndings("a\nb\nc", "crlf")).toBe("a\r\nb\r\nc")
  })
})

describe("assertTextData", () => {
  it("rejects binary (NUL byte)", () => {
    expect(() => assertTextData(new Uint8Array([0x68, 0x00, 0x69]))).toThrow(/binary|non-text/)
  })
  it("accepts UTF-8 text", () => {
    expect(assertTextData(new TextEncoder().encode("hi"))).toBe("hi")
  })
  it("rejects oversized", () => {
    expect(() => assertTextData(new TextEncoder().encode("x".repeat(100)), 10)).toThrow(/too large/i)
  })
})

describe("applyLiteralEdit", () => {
  it("replaces single occurrence", () => {
    const r = applyLiteralEdit("foo bar", "bar", "baz", false)
    expect(r).toEqual({ text: "foo baz", replacements: 1 })
  })
  it("reports ambiguous when multiple and not replaceAll", () => {
    const r = applyLiteralEdit("a b a", "a", "x", false)
    expect(r).toMatchObject({ error: "ambiguous", count: 2 })
  })
  it("replace_all replaces all", () => {
    const r = applyLiteralEdit("a b a", "a", "x", true)
    expect(r).toEqual({ text: "x b x", replacements: 2 })
  })
  it("reports not_found", () => {
    const r = applyLiteralEdit("abc", "zzz", "x", false)
    expect(r).toEqual({ error: "not_found" })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/fs && pnpm vitest run test/fs-atomic.test.ts test/fs-text.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 helpers**

```ts
// packages/fs/src/error.ts
export type FsToolErrorCode =
  | "FS_NOT_FOUND" | "FS_NOT_REGULAR_FILE"
  | "FS_EDIT_NOT_FOUND" | "FS_AMBIGUOUS_EDIT" | "FS_STALE_VERSION"
  | "FS_TOO_LARGE" | "FS_IO_ERROR"

export class FsToolError extends Error {
  readonly code: FsToolErrorCode
  constructor(code: FsToolErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "FsToolError"
  }
}
```

```ts
// packages/fs/src/atomic.ts
import { rename, writeFile, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join, basename } from "node:path"

// 同目錄 temp + rename（POSIX 原子；Windows NTFS rename 同目錄亦原子）。
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(tmp, content, "utf-8")
    await rename(tmp, path)
  } catch (err) {
    await import("node:fs/promises").then((m) => m.unlink(tmp)).catch(() => {})
    throw err
  }
}
```

```ts
// packages/fs/src/text.ts
import { FsToolError } from "./error.ts"

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

export function detectLineEndings(text: string): "crlf" | "lf" {
  const sample = text.slice(0, 4096)
  const crlf = (sample.match(/\r\n/g) ?? []).length
  const lfOnly = (sample.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lfOnly ? "crlf" : "lf"
}

export function restoreLineEndings(text: string, style: "crlf" | "lf"): string {
  return style === "crlf" ? text.replace(/\n/g, "\r\n") : text
}

const NUL_RE = /\u0000/

export function assertTextData(data: Uint8Array, maxBytes?: number): string {
  if (maxBytes !== undefined && data.byteLength > maxBytes) {
    throw new FsToolError("FS_TOO_LARGE", `file too large: ${data.byteLength} bytes (limit ${maxBytes})`)
  }
  if (NUL_RE.test(Buffer.from(data).toString("latin1"))) {
    throw new FsToolError("FS_NOT_REGULAR_FILE", "binary file (contains NUL byte) — not text")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    throw new FsToolError("FS_NOT_REGULAR_FILE", "file is not valid UTF-8 text")
  }
}

export type LiteralEditResult =
  | { text: string; replacements: number }
  | { error: "not_found" }
  | { error: "ambiguous"; count: number }

export function applyLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean): LiteralEditResult {
  if (oldString === newString) return { error: "ambiguous", count: 0 } // no-op prevented elsewhere too
  if (!replaceAll) {
    const idx = content.indexOf(oldString)
    if (idx === -1) return { error: "not_found" }
    const second = content.indexOf(oldString, idx + oldString.length)
    if (second !== -1) return { error: "ambiguous", count: (content.split(oldString).length - 1) }
    return { text: content.slice(0, idx) + newString + content.slice(idx + oldString.length), replacements: 1 }
  }
  const parts = content.split(oldString)
  if (parts.length === 1) return { error: "not_found" }
  return { text: parts.join(newString), replacements: parts.length - 1 }
}
```

```ts
// packages/fs/src/index.ts — resolvePath 修改（containment fail-closed）+ 重新 export
import { readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import type { Tool } from "@i-harness/core-tools"
import { FsToolError } from "./error.ts"

// 既有行為：絕對輸入原樣（讀取 workspace 外檔案——read 保留）；`..` 逃逸 → 現在拒
export function resolvePath(workspace: string, path: string): string {
  const isAbsoluteInput = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
  const resolved = isAbsoluteInput ? resolve(path) : resolve(workspace, path)
  if (!isAbsoluteInput) {
    const rel = relative(workspace, resolved)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new FsToolError("FS_NOT_FOUND", `path escapes workspace: ${path}`)
    }
  }
  return resolved
}
```

（注意：`edit`/`apply_patch` 工具需訪問 resolvePath 的判定——**保留絕對輸入允許**，但 `..` 逃逸拒絕；read/write/list_dir 現有行為：`..` 逃逸現在 fail-closed（已驗證既有測試無此 case）。）

- [ ] **Step 4: 加 containment 案例到既有 fs.test.ts**

```ts
// packages/fs/test/fs.test.ts — 追加（fs tools describe 內）
  it("resolvePath rejects .. escape (fail-closed)", () => {
    expect(() => resolvePath(dir, "../outside.txt")).toThrow(/escapes workspace/)
    expect(() => resolvePath(dir, "sub/../../outside.txt")).toThrow(/escapes workspace/)
  })
  it("resolvePath still allows absolute inputs (M1 behavior)", () => {
    // 絕對路徑原樣允許（read 可用於 workspace 外；containment 只擋相對 .. 逃逸）
    expect(resolvePath(dir, dir)).toBe(dir)
  })
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/fs && pnpm vitest run test/fs-atomic.test.ts test/fs-text.test.ts` 且 `pnpm vitest run`（全部 fs——含既有 6 case + 新 2 case）
Expected: PASS（既有測試無 `..` 案例，不破）

- [ ] **Step 6: Commit**

```bash
git add packages/fs/src/error.ts packages/fs/src/atomic.ts packages/fs/src/text.ts packages/fs/src/index.ts packages/fs/test/fs-atomic.test.ts packages/fs/test/fs-text.test.ts packages/fs/test/fs.test.ts
git commit -m "feat(M21): fs — FsToolError, writeFileAtomic, line-ending/binary helpers, resolvePath containment"
```

### Task 2: `edit` 工具

**Files:**
- Modify: `packages/fs/src/index.ts`（`createFsTools` 加 `edit`）
- Test: `packages/fs/test/fs-edit.test.ts`（新）

**Interfaces:**
- Consumes: `resolvePath`、`writeFileAtomic`、`applyLiteralEdit`、`normalizeLineEndings`/`detectLineEndings`/`restoreLineEndings`/`assertTextData`、`FsToolError`
- Produces: `Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; observedMtimeMs?: number }, { ok: boolean; path: string; replacements: number }>`（name `edit`；isReadOnly: false；isConcurrencySafe: 不設（寫工具，仿 write）；`observedMtimeMs` 為 M21 spec §4.2 mtime 檢查——read 觀察到後 edit 帶上，mtime 不符 → `FS_STALE_VERSION`）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/fs/test/fs-edit.test.ts
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
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/fs && pnpm vitest run test/fs-edit.test.ts`
Expected: FAIL（edit 工具不存在）

- [ ] **Step 3: 實現 edit 工具**

```ts
// packages/fs/src/index.ts — createFsTools 內加
const edit: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; observedMtimeMs?: number }, { ok: boolean; path: string; replacements: number }> = {
  name: "edit",
  description: "edit a file by literal string replacement (single occurrence unless replace_all)",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
      observedMtimeMs: { type: "number", description: "optional mtime observed from read; mismatch → reject (stale)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  isReadOnly: false,
  execute: async ({ path, old_string, new_string, replace_all = false, observedMtimeMs }) => {
    const target = resolvePath(deps.workspace, path)
    const { stat, readFile } = await import("node:fs/promises")
    let st
    try {
      st = await stat(target)
    } catch {
      throw new FsToolError("FS_NOT_FOUND", `file not found: ${path}`)
    }
    if (!st.isFile()) throw new FsToolError("FS_NOT_REGULAR_FILE", `not a regular file: ${path}`)
    if (observedMtimeMs !== undefined && Math.floor(st.mtimeMs) !== observedMtimeMs) {
      throw new FsToolError("FS_STALE_VERSION", `file changed since it was read (observed ${observedMtimeMs}, now ${Math.floor(st.mtimeMs)}) — re-read then retry`)
    }
    if (old_string === new_string) throw new FsToolError("FS_AMBIGUOUS_EDIT", "ambiguous: old_string must differ from new_string (no-op)")
    const raw = await readFile(target)
    const text = assertTextData(raw) // throws FS_NOT_REGULAR_FILE on binary/UTF-8
    const style = detectLineEndings(text)
    const normalized = normalizeLineEndings(text)
    const result = applyLiteralEdit(normalized, normalizeLineEndings(old_string), normalizeLineEndings(new_string), replace_all)
    if ("error" in result) {
      if (result.error === "not_found") throw new FsToolError("FS_EDIT_NOT_FOUND", `old_string not found in ${path}`)
      throw new FsToolError("FS_AMBIGUOUS_EDIT", `ambiguous: matched ${result.count} times in ${path}; provide more specific old_string or set replace_all`)
    }
    const finalText = restoreLineEndings(result.text, style)
    await writeFileAtomic(target, finalText)
    return { ok: true, path, replacements: result.replacements }
  },
}
return [read, edit, write, list_dir]
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/fs && pnpm vitest run test/fs-edit.test.ts` + 全部 fs
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fs/src/index.ts packages/fs/test/fs-edit.test.ts
git commit -m "feat(M21): fs — edit tool (literal replace, replace_all, mtime stale guard, CRLF preserve)"
```

### Task 3: `apply_patch` 工具（codex 格式解析 + 應用）

**Files:**
- Create: `packages/fs/src/patch.ts`（parser + apply）
- Modify: `packages/fs/src/index.ts`（`createFsTools` 加 `apply_patch`）
- Test: `packages/fs/test/fs-patch.test.ts`（新）

**Interfaces:**
- Consumes: `resolvePath`、`writeFileAtomic`、`assertTextData`、`normalizeLineEndings`/`detectLineEndings`/`restoreLineEndings`、`FsToolError`；`stat`/`readFile`（node:fs/promises）
- Produces:
  - `export interface PatchHunk { kind: "add" | "delete" | "update"; path: string; contents?: string; chunks?: PatchChunk[] }`（**無 movePath**——`*** Move to:` 明確拒絕，見下）
  - `export interface PatchChunk { context?: string; oldLines: string[]; newLines: string[]; isEndOfFile?: boolean }`
  - `export function parsePatch(patchContent: string): PatchHunk[]`（`*** Begin/End Patch` + `*** Add File:`/`*** Delete File:`/`*** Update File:` + `@@`/`+`/`-`/` ` 行 + `*** End of File`；行號錯誤 `FsToolError("FS_EDIT_NOT_FOUND", ...)`；**`*** Move to:` → 明確拒絕**（fail-closed，v0 用 delete+add 替代——研究已確認 codex 的 Move 語法極少用，且其臨時檔重排屬 best-effort））
  - `export function computeReplacements(text: string, chunks: PatchChunk[]): { text: string } | { error: string }`（seek_sequence 概念：cursor 依序定位（context-line 含在 oldLines）；**多 chunk 從尾部倒序應用**避免 offset 漂移；**純插入 old=="" → 一律附尾（codex 同款）**——isEndOfFile 只是標記；**絕不用 `String.replace("")`（會插到 index 0）**）
  - `export async function applyPatch(resolve: (path: string) => string, hunks: PatchHunk[]): Promise<{ applied: { path: string; action: "added" | "deleted" | "updated" }[]; errors: { path: string; message: string }[] }>`（**resolve 由 index.ts 傳入**——patch.ts 不 import index.ts（循環）；逐 hunk 應用；同 path 重複 → 錯誤；失敗即停 + 回報已應用清單）
  - `Tool<{ patch_content: string }, { ok: boolean; applied: { path: string; action: string }[]; errors: { path: string; message: string }[] }>`（name `apply_patch`；isReadOnly: false；**失敗回 `ok:false` + applied/errors（不 throw）**——讓模型看到進行到哪）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/fs/test/fs-patch.test.ts
import { describe, expect, it, beforeEach } from "vitest"
import { createFsTools } from "../src/index.ts"
import { writeFile, readFile, access, stat } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-patch-")) })
const tool = () => createFsTools({ workspace: dir }).find((t) => t.name === "apply_patch")!

const PATCH_ADD = `*** Begin Patch
*** Add File: new.txt
+hello
+world
*** End Patch
`
const PATCH_UPDATE = `*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** End Patch
`
const PATCH_DELETE = `*** Begin Patch
*** Delete File: old.txt
*** End Patch
`

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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/fs && pnpm vitest run test/fs-patch.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 patch.ts**

```ts
// packages/fs/src/patch.ts
// 不 import index.ts（循環）——resolve 函數由 index.ts 傳入（見 Step 3.5）。
import { readFile, stat, unlink } from "node:fs/promises"
import { writeFileAtomic } from "./atomic.ts"
import { assertTextData, normalizeLineEndings, detectLineEndings, restoreLineEndings } from "./text.ts"
import { FsToolError } from "./error.ts"

export interface PatchChunk {
  context?: string
  oldLines: string[]
  newLines: string[]
  isEndOfFile?: boolean
}
export interface PatchHunk {
  kind: "add" | "delete" | "update"
  path: string
  contents?: string
  chunks?: PatchChunk[]
}
export type PathResolver = (path: string) => string

// 解析 `*** Begin Patch` 格式（codex 語法的簡化吸收版；含行號錯誤）
export function parsePatch(patchContent: string): PatchHunk[] {
  const lines = patchContent.split("\n")
  if (lines[0] !== "*** Begin Patch") {
    throw new FsToolError("FS_EDIT_NOT_FOUND", `patch must start with *** Begin Patch (got ${JSON.stringify(lines[0])})`)
  }
  const hunks: PatchHunk[] = []
  let i = 1
  let endIndex = -1
  const seen = new Set<string>()
  while (i < lines.length) {
    const line = lines[i]
    if (line === "*** End Patch") { endIndex = i; break }
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim()
      if (!path) throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: Add File requires a path`)
      if (seen.has(path)) throw new FsToolError("FS_EDIT_NOT_FOUND", `duplicate path in patch: ${path}`)
      seen.add(path)
      const contents: string[] = []
      i++
      while (i < lines.length && lines[i].startsWith("+")) {
        contents.push(lines[i].slice(1))
        i++
      }
      hunks.push({ kind: "add", path, contents: contents.join("\n") + (contents.length ? "\n" : "") })
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim()
      if (!path) throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: Delete File requires a path`)
      if (seen.has(path)) throw new FsToolError("FS_EDIT_NOT_FOUND", `duplicate path in patch: ${path}`)
      seen.add(path)
      hunks.push({ kind: "delete", path })
      i++
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim()
      if (!path) throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: Update File requires a path`)
      if (seen.has(path)) throw new FsToolError("FS_EDIT_NOT_FOUND", `duplicate path in patch: ${path}`)
      seen.add(path)
      i++
      if (lines[i]?.startsWith("*** Move to: ")) {
        throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: *** Move to: is not supported (v0: delete + add instead)`)
      }
      const chunks: PatchChunk[] = []
      while (i < lines.length && lines[i] !== "*** End Patch" && !lines[i].startsWith("*** ")) {
        const chunk: PatchChunk = { oldLines: [], newLines: [] }
        if (lines[i].startsWith("@@")) {
          // codex 文法：`@@` → change_context: None；`@@ <text>` → Some(text)
          const ctxText = lines[i].slice(2).trim()
          chunk.context = ctxText === "" ? undefined : ctxText
          i++
        }
        while (i < lines.length && (lines[i].startsWith("+") || lines[i].startsWith("-") || lines[i].startsWith(" "))) {
          const l = lines[i]
          if (l.startsWith("+")) chunk.newLines.push(l.slice(1))
          else if (l.startsWith("-")) chunk.oldLines.push(l.slice(1))
          else { /* context line — 記在 oldLines 也 newLines 供定位 */ chunk.oldLines.push(l.slice(1)); chunk.newLines.push(l.slice(1)) }
          i++
        }
        // codex 文法：eof_line 在 change_line+ 之後（`+quux` 行後接 `*** End of File`）
        if (lines[i] === "*** End of File") { chunk.isEndOfFile = true; i++ }
        chunks.push(chunk)
      }
      if (chunks.length === 0) throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: Update File requires at least one change line`)
      hunks.push({ kind: "update", path, chunks })
      continue
    }
    // 未知行 → 錯誤（strict）
    throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: unexpected patch line ${JSON.stringify(line)}`)
  }
  if (endIndex === -1) {
    throw new FsToolError("FS_EDIT_NOT_FOUND", "patch missing *** End Patch")
  }
  // End Patch 之後的內容（第二個 Begin 區塊、殘留行）→ fail-closed（一個 patch = 一個區塊）
  const trailing = lines.slice(endIndex + 1).filter((l) => l.trim() !== "")
  if (trailing.length > 0) {
    throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${endIndex + 2}: unexpected content after *** End Patch: ${JSON.stringify(trailing[0])}`)
  }
  return hunks
}

// 依 cursor 逐 chunk 定位 + 找 oldLines（吸收 codex compute_replacements/seek_sequence）：
// - 行先 split 成 lines（去尾空元素——trailing newline 以「檔尾」表示）
// - cursor `lineIndex` 只前進（chunks 文件序）；`isEndOfFile` 時 oldLines 必須出現在檔尾
// - oldLines 空 → 純插入：插入點=EOF（file 尾）；**不用 String.replace("")**（會插 index 0 前）
// - 回傳 `{text}`（已套用所有 chunk 的新內容）或 `{error}`（含檔名由呼叫端渲染）
export function computeReplacements(text: string, chunks: PatchChunk[]): { text: string } | { error: string } {
  // 去尾空元素（codex NormalizeToLf 同款）；檔尾以「insertion point = lines.length」表示
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const replacements: { index: number; oldLen: number; newLines: string[] }[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const ctx = chunk.context
      const ctxIndex = findLines(lines, [ctx], lineIndex)
      if (ctxIndex === -1) return { error: `failed to find context line after offset ${lineIndex}: ${JSON.stringify(ctx)}` }
      lineIndex = ctxIndex + 1
    }
    const old = chunk.oldLines
    if (old.length === 0) {
      // 純插入：EOF（chunk 含 isEndOfFile 或無 old 皆插檔尾——codex 同款）
      replacements.push({ index: lines.length, oldLen: 0, newLines: chunk.newLines })
      continue
    }
    const found = findLines(lines, old, lineIndex)
    if (found === -1) return { error: `failed to find expected lines in file: ${JSON.stringify(old.slice(0, 3))}...` }
    if (chunk.isEndOfFile && found + old.length < lines.length) {
      return { error: `end-of-file chunk matched at line ${found + 1}, not the end of file: ${JSON.stringify(old.slice(0, 3))}...` }
    }
    replacements.push({ index: found, oldLen: old.length, newLines: chunk.newLines })
    lineIndex = found + old.length
  }
  // 倒序套用（避免 offset 漂移——codex apply_replacements 同款）
  let result = [...lines]
  for (const r of [...replacements].reverse()) {
    result.splice(r.index, r.oldLen, ...r.newLines)
  }
  return { text: result.join("\n") + "\n" }
}

// 在 lines[fromIndex..] 依序找 pattern 序列；回 index 或 -1
function findLines(lines: string[], pattern: string[], fromIndex: number): number {
  for (let i = fromIndex; i + pattern.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) { ok = false; break }
    }
    if (ok) return i
  }
  return -1
}

// 應用 hunks（逐 hunk；同 path 已由 parsePatch 擋；失敗即停 + 回報已應用/錯誤）
export async function applyPatch(resolve: PathResolver, hunks: PatchHunk[]): Promise<{ applied: { path: string; action: "added" | "deleted" | "updated" }[]; errors: { path: string; message: string }[] }> {
  const applied: { path: string; action: "added" | "deleted" | "updated" }[] = []
  const errors: { path: string; message: string }[] = []
  for (const hunk of hunks) {
    const target = resolve(hunk.path)
    try {
      if (hunk.kind === "add") {
        await writeFileAtomic(target, hunk.contents ?? "")
        applied.push({ path: hunk.path, action: "added" })
      } else if (hunk.kind === "delete") {
        await unlink(target)
        applied.push({ path: hunk.path, action: "deleted" })
      } else {
        // update
        const st = await stat(target).catch(() => { throw new FsToolError("FS_NOT_FOUND", `file not found: ${hunk.path}`) })
        if (!st.isFile()) throw new FsToolError("FS_NOT_REGULAR_FILE", `not a regular file: ${hunk.path}`)
        const raw = await readFile(target)
        const text = assertTextData(raw)
        const style = detectLineEndings(text)
        const normalized = normalizeLineEndings(text)
        const result = computeReplacements(normalized, hunk.chunks ?? [])
        if ("error" in result) throw new FsToolError("FS_EDIT_NOT_FOUND", `${result.error} (in ${hunk.path})`)
        await writeFileAtomic(target, restoreLineEndings(result.text, style))
        applied.push({ path: hunk.path, action: "updated" })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ path: hunk.path, message })
      break // 失敗即停
    }
  }
  return { applied, errors }
}
```

**Step 3.5: `packages/fs/src/index.ts` 加**（import + 工具 + return array 更新）：
```ts
import { parsePatch, applyPatch } from "./patch.ts"

const apply_patch: Tool<{ patch_content: string }, { ok: boolean; applied: { path: string; action: string }[]; errors: { path: string; message: string }[] }> = {
  name: "apply_patch",
  description: "apply a multi-file structured patch (*** Begin/End Patch + Add/Delete/Update + @@ context)",
  inputSchema: { type: "object", properties: { patch_content: { type: "string" } }, required: ["patch_content"] },
  isReadOnly: false,
  execute: async ({ patch_content }) => {
    const hunks = parsePatch(patch_content)
    // patch.ts 不 import index.ts（循環）——resolve 由這裡傳入
    const { applied, errors } = await applyPatch(resolvePath.bind(null, deps.workspace), hunks)
    if (errors.length > 0) {
      // 回報已應用清單 + 錯誤（不 throw——讓模型看到進行到哪）
      return { ok: false, applied, errors }
    }
    return { ok: true, applied, errors: [] }
  },
}
return [read, edit, write, apply_patch, list_dir]  // ← 更新回傳數組
```
（`parsePatch` 拋錯（格式錯誤/Move to/duplicate）→ 工具 reject；應用期錯誤 → `ok:false` 回報。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/fs && pnpm vitest run test/fs-patch.test.ts` + 全部 fs
Expected: PASS（6 新案例：add/update/delete/multi-file/context-not-found-ok:false/duplicate-throw/failed-batch/EOF-append/Move-to-reject——解析錯誤 reject、應用錯誤 ok:false）

- [ ] **Step 5: Commit**

```bash
git add packages/fs/src/patch.ts packages/fs/src/index.ts packages/fs/test/fs-patch.test.ts
git commit -m "feat(M21): fs — apply_patch tool (codex-format multi-file patch, context matching, partial-failure report)"
```

---

## Part 2: todo（新 `@i-harness/todo`）

### Task 4: core-session `todo/write` 事件 + session-persistence registerEventType

**Files:**
- Modify: `packages/core-session/src/index.ts`（SessionEvent union 加 `todo/write`）
- Modify: `packages/session-persistence/src/index.ts`（module init `registerEventType("todo/write")`）
- Test: `packages/core-session/test/todo-event.test.ts`（新）、`packages/session-persistence/test/todo-persistence.test.ts`（新）

**Interfaces:**
- Consumes: `append`（core-session L89）、`registerEventType`（session-persistence）
- Produces:
  - `export type TodoItemStatus = "pending" | "in_progress" | "completed"`
  - `export interface TodoItem { content: string; status: TodoItemStatus }`
  - SessionEvent union 成員：`| { type: "todo/write"; version: 1; items: TodoItem[]; seq?: number }`（內聯，仿 M19 team/task，避免循環依賴）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/core-session/test/todo-event.test.ts
import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("todo/write event", () => {
  it("appends and carries items", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "step 1", status: "pending" }] })
    const ev = s.events.at(-1)!
    expect(ev.type).toBe("todo/write")
    expect((ev as { items: unknown[] }).items).toHaveLength(1)
  })
  it("does not appear in deriveMessages (model-visible)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "todo/write", version: 1, items: [] })
    append(s, { type: "assistant/message", text: "ok" })
    const msgs = deriveMessages(s)
    expect(msgs).toHaveLength(2) // user + assistant; todo dropped
    expect(msgs.every((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")).toBe(true)
  })
  it("does not index in deriveSearchText", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "secret task", status: "pending" }] })
    expect(deriveSearchText(s.events[0])).toBe("")
  })
})
```

```ts
// packages/session-persistence/test/todo-persistence.test.ts
// 仿 coordinator.test.ts 的 team event round-trip：registerEventType 於 module
// init 已註冊，load gate（guardIgnorable）需放行 todo/write 且不明文 drop。
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("todo/write persistence", () => {
  it("survives append + JSONL load (KNOWN_EVENT_TYPES accepts it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-todo-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "todo/write", version: 1, items: [{ content: "step 1", status: "pending" }] },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual(["todo/write"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-session && pnpm vitest run test/todo-event.test.ts` + `cd packages/session-persistence && pnpm vitest run test/todo-persistence.test.ts`
Expected: FAIL（todo/write 不在 union——TS 錯誤；session-persistence 案例 FAIL 因 guardIgnorable 拒 unknown type——registerEventType 未註冊）

- [ ] **Step 3: 實現**

```ts
// packages/core-session/src/index.ts — SessionEvent union 加（仿 M19 team/task）
export type TodoItemStatus = "pending" | "in_progress" | "completed"
export interface TodoItem {
  content: string
  status: TodoItemStatus
}
// union 內：
| { type: "todo/write"; version: 1; items: TodoItem[]; seq?: number }
```

```ts
// packages/session-persistence/src/index.ts — module init（L92-99 同區）
registerEventType("todo/write")
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/core-session && pnpm vitest run` + `cd packages/session-persistence && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/session-persistence/src/index.ts packages/core-session/test/todo-event.test.ts packages/session-persistence/test/todo-persistence.test.ts
git commit -m "feat(M21): core-session todo/write event (additive, v1) + session-persistence registerEventType"
```

### Task 5: `@i-harness/todo` 包——createTodoTool + deriveTodoList

**Files:**
- Create: `packages/todo/package.json`、`packages/todo/tsconfig.json`、`packages/todo/src/index.ts`
- Test: `packages/todo/test/todo.test.ts`（新）

**Interfaces:**
- Consumes: `append`/`Session`/`TodoItem`（core-session）、`Tool`/`ToolExec`（core-tools）
- Produces:
  - `export interface TodoToolDeps { session: Session; allowParallelInProgress?: boolean }`
  - `export function createTodoTool(deps: TodoToolDeps): Tool<{ todos: TodoItem[] }, { todos: TodoItem[]; counts: { pending: number; inProgress: number; completed: number } }>`（name `todo_write`；isReadOnly: false；isConcurrencySafe: true）
  - `export function deriveTodoList(session: Session): TodoItem[] | null`（last-write-wins；回 null 無事件）
  - 驗證：content trim 非空、duplicate content 拒絕、allowParallelInProgress=false 時 at most one in_progress

- [ ] **Step 1: 建立包骨架 + workspace link**

```bash
mkdir -p packages/todo/src packages/todo/test
cd /d/agent-complete/I-harness && pnpm install  # 新 workspace 包建立 symlink（vitest/tsc 解析 @i-harness/*）
# packages/todo/package.json
{
  "name": "@i-harness/todo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-tools": "workspace:*"
  }
}
# packages/todo/tsconfig.json（仿 fs）
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 2: 寫失敗測試**

```ts
// packages/todo/test/todo.test.ts
import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createTodoTool, deriveTodoList } from "../src/index.ts"

describe("todo_write tool", () => {
  it("appends todo/write and returns counts", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    const out = (await tool.execute({ todos: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }] }, {})) as { counts: { pending: number; inProgress: number } }
    expect(out.counts).toEqual({ pending: 1, inProgress: 1, completed: 0 })
    expect(s.events.at(-1)!.type).toBe("todo/write")
  })
  it("rejects empty/whitespace content", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "   ", status: "pending" }] }, {})).rejects.toThrow(/empty|whitespace/i)
  })
  it("rejects duplicate content", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "a", status: "pending" }, { content: "a", status: "pending" }] }, {})).rejects.toThrow(/duplicate/i)
  })
  it("rejects multiple in_progress when allowParallelInProgress false", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, {})).rejects.toThrow(/one.*in_progress|at most one/i)
  })
  it("allowParallelInProgress true permits multiple", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s, allowParallelInProgress: true })
    const out = (await tool.execute({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, {})) as { counts: { inProgress: number } }
    expect(out.counts.inProgress).toBe(2)
  })
})

describe("deriveTodoList", () => {
  it("returns null with no todo/write events", () => {
    const s = createSession()
    expect(deriveTodoList(s)).toBeNull()
  })
  it("last-write-wins", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "old", status: "pending" }] })
    append(s, { type: "todo/write", version: 1, items: [{ content: "new", status: "completed" }] })
    expect(deriveTodoList(s)).toEqual([{ content: "new", status: "completed" }])
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd packages/todo && pnpm vitest run test/todo.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 4: 實現**

```ts
// packages/todo/src/index.ts
import type { Session, TodoItem } from "@i-harness/core-session"
import { append } from "@i-harness/core-session" // 只用 append（deriveMessages 不需要——todo 事件 model-visible 外的存活由 deriveMessages 的 default-skip 保證）
import type { Tool } from "@i-harness/core-tools"

export interface TodoToolDeps {
  session: Session
  allowParallelInProgress?: boolean
}

export function validateTodoItems(items: TodoItem[], allowParallelInProgress: boolean): void {
  const seen = new Set<string>()
  let inProgress = 0
  for (const item of items) {
    if (!item.content || item.content.trim().length === 0) {
      throw new Error("todo: content must be non-empty")
    }
    if (seen.has(item.content)) throw new Error(`todo: duplicate content "${item.content}"`)
    seen.add(item.content)
    if (item.status === "in_progress") inProgress++
  }
  if (!allowParallelInProgress && inProgress > 1) {
    throw new Error("todo: at most one item may be in_progress (set allowParallelInProgress to enable more)")
  }
}

export function createTodoTool(deps: TodoToolDeps): Tool<{ todos: TodoItem[] }, { todos: TodoItem[]; counts: { pending: number; inProgress: number; completed: number } }> {
  return {
    name: "todo_write",
    description: "replace the entire todo list (send the WHOLE list every call; it REPLACES the previous)",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    isReadOnly: false,
    isConcurrencySafe: true,
    execute: async ({ todos }) => {
      validateTodoItems(todos, deps.allowParallelInProgress ?? false)
      append(deps.session, { type: "todo/write", version: 1, items: todos })
      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        inProgress: todos.filter((t) => t.status === "in_progress").length,
        completed: todos.filter((t) => t.status === "completed").length,
      }
      return { todos, counts }
    },
  }
}

export function deriveTodoList(session: Session): TodoItem[] | null {
  let last: TodoItem[] | null = null
  for (const ev of session.events) {
    if (ev.type === "todo/write") last = (ev as { items: TodoItem[] }).items
  }
  return last
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/todo && pnpm vitest run test/todo.test.ts` + `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/todo/ && git commit -m "feat(M21): @i-harness/todo — todo_write whole-list tool + deriveTodoList last-write-wins"
```

---

## Part 3: tool-output-spill-files（A 層 exec 串流 + B 層結果級）

### Task 6: A 層——exec 串流 `OutputCollector`（tail-keep + overflow spill）

**Files:**
- Create: `packages/exec/src/spill.ts`（`OutputCollector`——**本 task 只建獨立模組 + 其 unit test，不碰 index.ts**——index.ts 接入屬 Task 7）
- Test: `packages/exec/test/spill.test.ts`（新）

**Interfaces:**
- Consumes: `tmpdir`/`mkdtempSync`/`openSync`/`writeSync`/`closeSync`/`unlinkSync`（node:fs）、`randomBytes`（node:crypto）、`join`（node:path）
- Produces:
  - `export interface OutputCollectorOptions { maxBytes: number; maxSpillBytes?: number; label?: string; spillRoot?: string }`（**maxBytes 必填**——呼叫端給定；spillRoot 省略 → `mkdtempSync(join(tmpdir(), "i-harness-spill-"))` 0700 per-process）
  - `export interface CollectResult { text: string; spillPath?: string; lossy: boolean; truncated: boolean }`
  - `export class OutputCollector { push(chunk: Buffer): void; finalize(): CollectResult }`（**無 getter**——spillPath 由 finalize() 的 CollectResult 帶出；private field 同名，不加 getter 避免衝突）
  - 行為：`push` 累計 total；首次 `total > maxBytes` → 開 spill 檔（**open 失敗/開後寫失敗 → spillDisabled 永久停用**）、把 retained chunks + 新 chunk 全寫（溢寫前無 byte 丟 → spill 檔 = 完整 stream）；之後每 chunk 附寫；內存 tail-keep（最後 maxBytes，**單一 chunk > maxBytes 時保留整 chunk**——chunks.length > 1 才 drop）；`total > maxSpillBytes` → discardSpill（close + unlink + 永久停用）→ 只剩 tail；`finalize()`：`truncated = total > maxBytes`；**`lossy = truncated && spillPath === undefined`**（有完整 spill 檔則非 lossy——完整資料在檔；無 spill 檔（discard/開檔失敗）才 lossy）；`text` = 內存 tail（truncated 時）+ 完整（未 truncated 時）。

**Design note (binding):** 這是吸收 dsh `OutputCollector`（subprocess-local/spawn.ts）的極簡版。**內存累積策略**：push 保持「目前所有 chunks」直到 overflow（首次 overflow 前無 byte 丟棄）；overflow 後內存只留 tail（bounded）。`done` 的 reject path（SandboxUnavailableError）——spill 檔已建則保留 spillPath 於 done resolve 的 ExecResult；reject 直接拋（spill 檔孤兒）。

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/exec/test/spill.test.ts
import { describe, expect, it } from "vitest"
import { OutputCollector } from "../src/spill.ts"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("OutputCollector", () => {
  it("keeps everything under maxBytes (no spill)", () => {
    const c = new OutputCollector({ maxBytes: 100, spillRoot: mkdtempSync(join(tmpdir(), "i-harness-spill-")) })
    c.push(Buffer.from("hello"))
    const r = c.finalize()
    expect(r.text).toBe("hello")
    expect(r.spillPath).toBeUndefined()
    expect(r.truncated).toBe(false)
  })
  it("spills complete stream on overflow", () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-"))
    const c = new OutputCollector({ maxBytes: 10, spillRoot: root, label: "test" })
    const chunk1 = Buffer.from("hello ") // 6
    const chunk2 = Buffer.from("world!") // 6 → total 12 > 10
    c.push(chunk1)
    c.push(chunk2)
    const r = c.finalize()
    expect(r.spillPath).toBeDefined()
    expect(r.truncated).toBe(true)
    // spill 檔是完整 stream（含 overflow 前 chunk）
    expect(readFileSync(r.spillPath!, "utf-8")).toBe("hello world!")
  })
  it("discards spill beyond maxSpillBytes (tail only)", () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-"))
    const c = new OutputCollector({ maxBytes: 5, maxSpillBytes: 20, spillRoot: root, label: "t" })
    c.push(Buffer.from("0123456789")) // 10 > 5 → spill
    c.push(Buffer.from("abcdefghijklmnopqrstuvwxyz")) // +26 → total 36 > 20 → discard
    const r = c.finalize()
    expect(r.spillPath).toBeUndefined()
    expect(r.lossy).toBe(true) // 中間被丟（只保尾）
    expect(r.text.endsWith("uvwxyz")).toBe(true) // 尾保留
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/exec && pnpm vitest run test/spill.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現 OutputCollector**

```ts
// packages/exec/src/spill.ts
import { openSync, writeSync, closeSync, unlinkSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

export interface OutputCollectorOptions {
  maxBytes: number
  maxSpillBytes?: number
  label?: string
  spillRoot?: string
}

export interface CollectResult {
  text: string
  spillPath?: string
  lossy: boolean
  truncated: boolean
}

// 吸收 dsh subprocess OutputCollector（tail-keep + 首次 overflow 全量寫 + spill cap 退化）
export class OutputCollector {
  private chunks: Buffer[] = []          // 溢出前：全部；溢出後：tail（last maxBytes）
  private tailBytes = 0
  private total = 0
  private spillFd: number | undefined
  private spillPath: string | undefined
  private spillDisabled = false
  private readonly maxBytes: number
  private readonly maxSpillBytes: number
  private readonly label: string
  private readonly spillRoot: string

  constructor(opts: OutputCollectorOptions) {
    this.maxBytes = opts.maxBytes
    this.maxSpillBytes = opts.maxSpillBytes ?? 64 * 1024 * 1024
    this.label = opts.label ?? "output"
    this.spillRoot = opts.spillRoot ?? mkdtempSync(join(tmpdir(), "i-harness-spill-"))
  }

  push(chunk: Buffer): void {
    this.total += chunk.byteLength
    // 溢出判定（spill 已停用時不重啟）
    if (!this.spillDisabled && (this.spillFd === undefined ? this.total > this.maxBytes : true)) {
      if (this.spillFd === undefined) {
        this.openSpill()
        // 溢出當下把 retained 全寫（完整 stream）
        for (const c of this.chunks) this.writeSpill(c)
      }
      this.writeSpill(chunk)
    }
    // tail-keep 內存
    this.chunks.push(chunk)
    this.tailBytes += chunk.byteLength
    while (this.tailBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.tailBytes -= dropped.byteLength
    }
    // 超 spill cap → discard
    if (!this.spillDisabled && this.spillFd !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
    }
  }

  finalize(): CollectResult {
    const text = Buffer.concat(this.chunks).toString("utf-8")
    const truncated = this.total > this.maxBytes
    const spillPath = this.spillPath
    // 有完整 spill 檔 → 資料無損（lossy=false）；無 spill 檔且 truncated → 中間丟（lossy=true）
    const lossy = truncated && spillPath === undefined
    if (this.spillFd !== undefined) { closeSync(this.spillFd); this.spillFd = undefined }
    return { text, spillPath, lossy, truncated }
  }

  private openSpill(): void {
    const name = `i-harness-spill-${Date.now()}-${randomBytes(6).toString("hex")}-${encodeSegment(this.label)}.log`
    const p = join(this.spillRoot, name)
    try {
      this.spillFd = openSync(p, "wx", 0o600)
      this.spillPath = p
    } catch {
      this.spillDisabled = true // 開檔失敗 → 停用（best-effort）
    }
  }
  private writeSpill(chunk: Buffer): void {
    if (this.spillFd === undefined) return
    try { writeSync(this.spillFd, chunk) } catch { this.discardSpill() }
  }
  private discardSpill(): void {
    if (this.spillFd !== undefined) { try { closeSync(this.spillFd) } catch {} ; this.spillFd = undefined }
    if (this.spillPath) { try { unlinkSync(this.spillPath) } catch {} }
    this.spillPath = undefined
    this.spillDisabled = true
  }
}

function encodeSegment(s: string): string {
  // injective 安全段編碼（吸收 dsh encodeSegment）
  let out = ""
  for (const ch of s) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else if (ch === "." || ch === "..") out += "~"
    else out += `~${ch.codePointAt(0)!.toString(16)}`
  }
  return out || "~"
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/exec && pnpm vitest run test/spill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/src/spill.ts packages/exec/test/spill.test.ts
git commit -m "feat(M21): exec — OutputCollector (tail-keep, overflow spill complete stream, spill-cap discard)"
```

### Task 7: A 層——exec spawnChild 接入 + ExecResult 欄位

**Files:**
- Modify: `packages/exec/src/index.ts`（`ExecServiceOptions` 加 spill 選項；spawnChild 接入；ExecResult 加 `spillPath?`/`truncated?`）
- Test: `packages/exec/test/exec-spill.test.ts`（新）

**Interfaces:**
- Consumes: `OutputCollector`（Task 6）、既有 `spawnChild`/`SpawnHandle`（exec/src/index.ts L60-88）
- Produces:
  - `export interface ExecSpillOptions { maxOutputBytes?: number; maxSpillBytes?: number }`（maxOutputBytes 預設 64_000）
  - `export interface ExecServiceOptions { sandbox?: SandboxProvider; spill?: ExecSpillOptions }`（`createExecService(deps?: ExecServiceOptions)`——既有 deps 已是 options）
  - `ExecResult` 加 `stdoutSpillPath?: string`、`stderrSpillPath?: string`、`truncated?: { stdout: boolean; stderr: boolean }`（**stdout 保留 tail 語義**：`stdout` 欄位永遠是內存 tail 或全量——A 層 spill 的完整內容在 spill 檔）
  - `SpawnHandle.done` resolve 的物件加同欄位
  - **`runBackground` 不接 spill**（保持累積到 job.stdout——M21 範圍只做 foreground `run`；background 語義是 stream-observable）

- [ ] **Step 1: 寫失敗測試**

```ts
// packages/exec/test/exec-spill.test.ts
import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"
import { readFileSync } from "node:fs"

describe("exec spill integration", () => {
  it("spills stdout when exceeding maxOutputBytes", async () => {
    // 仿既有 exec.test.ts：無 sandbox、argv 用 process.execPath（Windows 優先）
    const exec = createExecService({ spill: { maxOutputBytes: 20 } })
    const r = await exec.run({ argv: [process.execPath, "-e", "console.log('x'.repeat(100))"] })
    expect(r.stdoutSpillPath).toBeDefined()
    expect(r.truncated?.stdout).toBe(true)
    // spill 檔含完整輸出（tail 以外的部分也在）
    const full = readFileSync(r.stdoutSpillPath!, "utf-8")
    expect(full).toContain("x".repeat(100))
  }, 10_000)
  it("no spill under limit", async () => {
    const exec = createExecService({ spill: { maxOutputBytes: 64_000 } })
    const r = await exec.run({ argv: [process.execPath, "-e", "console.log('hi')"] })
    expect(r.stdoutSpillPath).toBeUndefined()
    expect(r.truncated).toBeUndefined()
  }, 10_000)
})
```

（測試無 sandbox——輸出經 `console.log` + stdout；Windows 下 `process.execPath` 直接可用。若 CI 無 spawn 會失敗是環境問題非測試問題——既有 exec.test.ts 同模式。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/exec && pnpm vitest run test/exec-spill.test.ts`
Expected: FAIL（欄位不存在）

- [ ] **Step 3: 實現**

```ts
```ts
// packages/exec/src/index.ts（相關部分，完整改寫點）
import { OutputCollector } from "./spill.ts"

export interface ExecSpillOptions { maxOutputBytes?: number; maxSpillBytes?: number }
export interface ExecServiceOptions { sandbox?: SandboxProvider; spill?: ExecSpillOptions }

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  // M21 spill:
  stdoutSpillPath?: string
  stderrSpillPath?: string
  truncated?: { stdout: boolean; stderr: boolean }
}

function spawnChild(cmd: ExecCommand, sandboxProvider?: SandboxProvider, spill?: ExecSpillOptions): SpawnHandle {
  // 既有 spawnChild 簽名 L60 是 (cmd, sandboxProvider)——加第三參數 spill
  const maxOut = spill?.maxOutputBytes ?? 64_000
  const stdoutCollector = spill ? new OutputCollector({ maxBytes: maxOut, maxSpillBytes: spill.maxSpillBytes, label: "stdout" }) : undefined
  const stderrCollector = spill ? new OutputCollector({ maxBytes: maxOut, maxSpillBytes: spill.maxSpillBytes, label: "stderr" }) : undefined
  // ...（其餘同既有——stdout/stderr 累積改為 collector 分支）：
  child.stdout?.on("data", (d: Buffer) => { if (stdoutCollector) stdoutCollector.push(d); else stdout += d.toString("utf-8") })
  child.stderr?.on("data", (d: Buffer) => { if (stderrCollector) stderrCollector.push(d); else stderr += d.toString("utf-8") })
  // doneFn 內（resolve 前，runner-failure reject path 之後）：
  const sOut = stdoutCollector ? stdoutCollector.finalize() : { text: stdout, spillPath: undefined, truncated: false, lossy: false }
  const sErr = stderrCollector ? stderrCollector.finalize() : { text: stderr, spillPath: undefined, truncated: false, lossy: false }
  const cleanOut = sOut.text.replace(/\r\n/g, "\n")
  const cleanErr = sErr.text.replace(/\r\n/g, "\n")
  resolveDone({
    stdout: cleanOut,
    stderr: cleanErr,
    exitCode: code,
    timedOut,
    // 只在有 spill 配置時帶欄位（現有測試斷言無 truncate 行為不破）
    ...(spill ? {
      stdoutSpillPath: sOut.spillPath,
      stderrSpillPath: sErr.spillPath,
      truncated: { stdout: sOut.truncated, stderr: sErr.truncated },
    } : {}),
  })
}
// runBackground 的 spawnChild 呼叫不傳 spill（保持累積到 job.stdout/stderr）
// createExecService：const handle = spawnChild(cmd, provider, deps?.spill)
// run() 不能再用舊的 4 欄對映（會丟 spill 欄位）——直接回 h.done（型別同 ExecResult）：
async run(cmd: ExecCommand): Promise<ExecResult> {
  const h = spawnChild(cmd, provider, deps?.spill)
  return h.done
}
```

（注意：`runBackground` 用同 spawnChild——**第三參數不傳**，背景 job 維持 stream-observable 語義；`SpawnHandle.done` 型別同步加欄位（`truncated?: { stdout: boolean; stderr: boolean }; stdoutSpillPath?: string; stderrSpillPath?: string`）。既有 doneFn 的 runner-failure reject path 不變——reject 直接拋，spill 檔孤兒（task 6 design note）。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/exec && pnpm vitest run test/exec-spill.test.ts` + 全 exec（既有不破）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/src/index.ts packages/exec/test/exec-spill.test.ts
git commit -m "feat(M21): exec — wire OutputCollector into spawnChild, ExecResult spill/truncated fields"
```

### Task 8: B 層——shell retainedRunResult 的 spill preview + notice

**Files:**
- Modify: `packages/output-retention/src/index.ts`（加 `createSpillStore` + `spillNotice`）
- Modify: `packages/shell/src/index.ts`（createShellTools 建 spillStore；retainedRunResult 截斷時寫 spill + 併 notice）
- Test: `packages/output-retention/test/spill-store.test.ts`（新——unit）、`packages/shell/test/spill-notice.test.ts`（新——integration）

**Interfaces:**
- Consumes: `createTextRetainer`（output-retention 既有）、`exec.run` 完整結果（shell 既有 L108-109）、既有 `ShellRetentionOptions`（L84-87）
- Produces:
  - `export interface SpillStoreOptions { root?: string }`（root 省略 → `mkdtempSync(join(tmpdir(), "i-harness-retention-spill-"))` 0700 per-process——研究決策：**不寫進 workspace**）
  - `export function createSpillStore(opts?: SpillStoreOptions): SpillStore`（`SpillStore = { saveText(text: string, label: string): Promise<string> }`；寫完整原文到 `<root>/<label>-<randomBytes(6).hex>.log`，`openSync("wx", 0o600)`；回絕對 path）
  - `export function spillNotice(omittedBytes: number, path: string): string`（`(Omitted N bytes. Full result stored at: <path>. Use read with offset/limit, or grep this path to search within it.)`）
  - `ShellRetentionOptions` 加 `spill?: SpillStoreOptions`（additive——不設則行為完全同前）
  - `retainedRunResult` 改 async：`truncated` 且 spillStore 存在時——寫**完整 stdout**（exec.run 的未裁結果）→ notice 併入 preview 尾
  - **設計決策（已定，非 pending）**：B 層「完整內容」= shell 的 `execute` 呼叫 `deps.exec.run(...)` 回傳的**完整** stdout/stderr（現有 L150/160 即是），先傳入 retainedRunResult 才裁——所以 retain 前結果就是完整的。notice 併入 preview 不佔 preview 預算（dsh 同款——notice 附加、預算不重算）

- [ ] **Step 1: 寫失敗測試（unit）**

```ts
// packages/output-retention/test/spill-store.test.ts
import { describe, expect, it } from "vitest"
import { createSpillStore, spillNotice } from "../src/index.ts"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("spill helpers", () => {
  it("spillNotice formats correctly", () => {
    expect(spillNotice(1234, "C:/spill/f.log")).toBe(
      "(Omitted 1234 bytes. Full result stored at: C:/spill/f.log. Use read with offset/limit, or grep this path to search within it.)",
    )
  })
  it("createSpillStore saves full text and returns path", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-notice-"))
    const store = createSpillStore({ root })
    const p = await store.saveText("full content here", "bash")
    expect(p.startsWith(root)).toBe(true)
    expect(p).toContain("bash")
    expect(readFileSync(p, "utf-8")).toBe("full content here")
  })
})
```

- [ ] **Step 2: 寫失敗測試（integration——shell 經 createShellTools）**

```ts
// packages/shell/test/spill-notice.test.ts
// 延用 shell.test.ts 的 fakeExec 模式（L239 起）：retention 邏輯只需 exec.run 回傳完整結果。
import { describe, expect, it } from "vitest"
import { createShellTools } from "../src/index.ts"
import type { ExecService } from "@i-harness/exec"
import { createSpillStore } from "@i-harness/output-retention"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function fakeExec(runResult: { stdout: string; stderr: string; exitCode: number }): ExecService {
  return {
    run: async () => ({ ...runResult, timedOut: false }),
    runBackground: () => ({ jobId: "none" }),
    getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }
}

describe("shell spill notice", () => {
  it("truncated result appends notice and spills full stdout", async () => {
    const big = "x".repeat(1000)
    const root = mkdtempSync(join(tmpdir(), "i-harness-shell-spill-"))
    const tools = createShellTools({
      exec: fakeExec({ stdout: big, stderr: "", exitCode: 0 }),
      retention: { maxBytes: 100, spill: { root } },
    })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as {
      stdout: string
      truncated: { stdoutBytes: number; stderrBytes: number }
    }
    expect(res.truncated).toEqual({ stdoutBytes: 900, stderrBytes: 0 })
    expect(res.stdout).toContain("(Omitted 900 bytes. Full result stored at:")
    // spill 檔存在於 root（內容正確性由 output-retention unit 測）
    const files = await import("node:fs/promises").then((m) => m.readdir(root))
    expect(files.some((f) => f.startsWith("bash-stdout-"))).toBe(true)
  })
  it("no spill config → today's behavior (no notice)", async () => {
    const big = "x".repeat(1000)
    const tools = createShellTools({ exec: fakeExec({ stdout: big, stderr: "", exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string }
    expect(res.stdout).not.toContain("stored at:")
  })
})
```

（注：integration 測試驗證 notice 併入 + 不破既有行為；spill 檔**內容**由 output-retention unit 測（saveText）——shell 測試只用 readdir 確認檔產生。）

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd packages/output-retention && pnpm vitest run test/spill-store.test.ts` + `cd packages/shell && pnpm vitest run test/spill-notice.test.ts`
Expected: FAIL（helpers 不存在；integration 的 retention 無 spill 行為）

- [ ] **Step 4: 實現 output-retention**

```ts
// packages/output-retention/src/index.ts 加（module 尾）
import { mkdtempSync, openSync, writeSync, closeSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

export interface SpillStoreOptions {
  root?: string
}
export interface SpillStore {
  saveText(text: string, label: string): Promise<string>
}

// 吸收 dsh tool-output-spill-files B 層：完整原文落檔（0700 per-process temp root，
// 絕不寫 workspace——研究決策；不清理（已知 limitation））。
export function createSpillStore(opts?: SpillStoreOptions): SpillStore {
  const root = opts?.root ?? mkdtempSync(join(tmpdir(), "i-harness-retention-spill-"))
  mkdirSync(root, { recursive: true })
  return {
    async saveText(text: string, label: string): Promise<string> {
      const name = `${label}-${randomBytes(6).toString("hex")}.log`
      const p = join(root, name)
      const fd = openSync(p, "wx", 0o600)
      try {
        writeSync(fd, Buffer.from(text, "utf-8"))
        closeSync(fd)
      } catch (err) {
        try { closeSync(fd) } catch { /* ignore */ }
        throw err
      }
      return p
    },
  }
}

export function spillNotice(omittedBytes: number, path: string): string {
  return `(Omitted ${omittedBytes} bytes. Full result stored at: ${path}. Use read with offset/limit, or grep this path to search within it.)`
}
```

- [ ] **Step 5: 實現 shell 接入**

```ts
// packages/shell/src/index.ts（相關部分）
import { createTextRetainer, createSpillStore, spillNotice, type RetentionMode, type SpillStore, type SpillStoreOptions } from "@i-harness/output-retention"

export interface ShellRetentionOptions {
  maxBytes?: number
  mode?: RetentionMode
  // M21 B 層：truncated 時把完整輸出寫 spill + 併 notice（additive——不設=同前）
  spill?: SpillStoreOptions
}

export function createShellTools(deps: ShellToolDeps): Tool[] {
  const retention = deps.retention
    ? createTextRetainer({ maxBytes: deps.retention.maxBytes ?? 64_000, mode: deps.retention.mode })
    : null
  // spillStore 一次建、跨呼叫重用（寫檔無狀態；root 固定）
  const spillStore: SpillStore | undefined = deps.retention?.spill ? createSpillStore(deps.retention.spill) : undefined

  async function retainedRunResult(result: { stdout: string; stderr: string; exitCode: number }) {
    if (retention === null) return { stdout: result.stdout, exitCode: result.exitCode } // 現有 shape 不變
    const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
    so.push(result.stdout)
    se.push(result.stderr)
    const rs = so.finish()
    const re = se.finish()
    const truncated = rs.truncated || re.truncated
    let stdout = rs.text
    if (truncated && spillStore) {
      // 完整內容 = result.stdout（retain 前）——spill 檔保留全量
      const spillPath = await spillStore.saveText(result.stdout, "bash-stdout")
      stdout = rs.text + "\n" + spillNotice(rs.omittedBytes, spillPath)
    }
    return {
      stdout,
      stderr: re.text,
      exitCode: result.exitCode,
      ...(truncated ? { truncated: { stdoutBytes: rs.omittedBytes, stderrBytes: re.omittedBytes } } : {}),
    }
  }
  // execute: `return retainedRunResult(result)`——async fn 回 promise 自動展平（既有呼叫面不變）
}
```

（注意：`retainedRunResult` 由同步改 async——呼叫點 `return retainedRunResult(result)` 在 async execute 內，promise 直接 return 即展平，**無行為破壞**。stderr 的 spill notice 不併（只 stdout——dsh 同款，stderr 本來就以 truncated marker 回報）。）

- [ ] **Step 6: 跑測試確認通過**

Run: `cd packages/output-retention && pnpm vitest run` + `cd packages/shell && pnpm vitest run`（既有 retention 3 case 不破——no spill 配置 path 完全相同）
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/output-retention/src/index.ts packages/output-retention/test/spill-store.test.ts packages/shell/src/index.ts packages/shell/test/spill-notice.test.ts
git commit -m "feat(M21): retention — createSpillStore + spillNotice; shell truncated result spills full output + notice"
```

---

## 驗證（全文完）

- [ ] **Step: 跑全部 M21 相關測試（package + 全 workspace）**

```bash
cd packages/fs && pnpm vitest run
cd packages/todo && pnpm vitest run
cd packages/exec && pnpm vitest run
cd packages/output-retention && pnpm vitest run
cd packages/shell && pnpm vitest run
cd packages/core-session && pnpm vitest run
cd packages/session-persistence && pnpm vitest run
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS（含既有：fs 6+2 case、exec 既有+2、shell 既有 3 retention case、session-persistence 既有 coordinator round-trip）

---

## Plan Self-Review 紀錄（2026-08-27 自審，含實作前驗證修正）

1. **Spec 覆蓋**：M21 spec §4 三子系統 → Part 1 (edit/apply_patch) + Part 2 (todo) + Part 3 (spill A/B) 全覆蓋；§4.2 mtime 檢查（edit 的 observedMtimeMs）、§4.3 測試（unit + 多檔批次 + mtime 衝突 + spill）皆有對應 task。
2. **Placeholder 掃描**：已清空 3 個 Ruling-pending/TODO 痕跡——Task 3「Ruling/設計待定」改為確定方案（resolve 傳入、Move to fail-closed、線演算法）；Task 7「或 createExecService? 檢查」改為確定（既有 exec.test.ts 模式：無 sandbox + process.execPath）；Task 8「Ruling pending」改為確定（完整內容=exec.run 未裁結果）。
3. **型別一致性（修正後）**：
   - `patch.ts`：`applyPatch(resolve: PathResolver, hunks)` ↔ index.ts `applyPatch(resolvePath.bind(null, deps.workspace), hunks)`；`computeReplacements` 回 `{text} | {error}`（已與 applyPatch 對齊）；無 movePath。
   - `exec`：`ExecResult.stdoutSpillPath/stderrSpillPath/truncated?: {stdout,stderr}` ↔ `SpawnHandle.done` 同型別；`OutputCollector` 無 getter（finalize 帶出）。
   - `spill`：`createSpillStore(opts?: {root?})` + `spillNotice(omittedBytes, path)` ↔ shell `ShellRetentionOptions.spill`。
4. **驗證過的事實**（非猜測）：
   - fs.test.ts 無 `..` 案例——resolvePath containment 不破；絕對輸入 case 已加。
   - session-persistence 的 `registerEventType` module-init 模式（M19 team 4 型 + M20 compaction/reset）——todo/write 同位置；persistence test 用 coordinator+jsonl round-trip（仿 coordinator.test.ts）。
   - codex `*** End of File` 在 `+` 行**之後**（parser.rs test 確認）——EOF append 測試已校正。
   - codex compute_replacements：純插入(old=[]) → insertion point = EOF；context 在 oldLines 內（` ` 行）、`@@` 無 context、`@@ text` 有——已對齊。
   - exec 既有測試用 `process.execPath` 無 sandbox——Task 7 測試同模式；`runBackground` 不接 spill。
   - shell retention 已有 3 個測試（truncated marker / no-truncated / no-config shape）——B 層 additive 不破（no spill config → 同形狀）。
5. **已知風險（實作時留意）**：
   - Task 2 stale-mtime test 用 `Math.floor(before.mtimeMs)` + 20ms sleep——Windows NTFS mtime 粒度 100ms，若 flaky 改 `setTimeout(120)` 或比較 size；先以寫入前後 content 改變為準。
   - Task 5 `createTodoTool` 的回傳 type 含 counts 三欄——測試斷言 `{pending:1, inProgress:1, completed:0}` 需寫齊（計畫已對齊）。
   - Task 7 `createExecService(deps?: { sandbox?; spill? })`——既有呼叫 `createExecService({})`/`createExecService()` 不破（spill optional）。

## 暫不處理（deferred——記錄）
- **goal**（spec 延後）
- 細粒度 todo CRUD（todo_list/create/update/delete——延後）
- todo 每 turn 注入 system prompt（延後；記 Note：注入點建議 core-agent step 前置 context）
- win32 DACL secure-replace（延後——M22）
- sandbox_permissions/justification 欄位（延後——M22）
- symlink 跟隨（延後——M22）
- codex shell 攔截（延後——M22 重估）
- spill 檔清理（不清理——已知 limitation）
- codex Freeform grammar / streaming / environment_id（丟棄）
