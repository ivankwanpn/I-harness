// 不 import index.ts（循環）——resolve 函數由 index.ts 傳入（見 createFsTools）。
import { readFile, stat, unlink } from "node:fs/promises"
import { writeFileAtomic } from "./atomic.ts"
import { assertSnapshotFresh } from "./version.ts"
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
        // fail-closed：v0 不支援 move（codex 的臨時檔重排屬 best-effort）——用 delete+add 替代
        throw new FsToolError("FS_EDIT_NOT_FOUND", `line ${i + 1}: *** Move to: is not supported (v0: delete + add instead)`)
      }
      const chunks: PatchChunk[] = []
      while (i < lines.length && lines[i] !== "*** End Patch" && !lines[i].startsWith("*** ") && lines[i].trim() !== "") {
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
          else { /* context line（` ` 前綴）——記進 old/new 兩側供定位與重寫 */ chunk.oldLines.push(l.slice(1)); chunk.newLines.push(l.slice(1)) }
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
    // 未知行（含空行／不支援指令）→ 錯誤（strict；空行若在 chunk 迴圈外仍會落到這裡，避免静默吞掉）
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
// - cursor `lineIndex` 只前進（chunks 文件序）；context 行先定位再推進 cursor，接著找 oldLines
// - oldLines 空 → 純插入：插入點=EOF（file 尾）；**不用 String.replace("")**（會插 index 0 前）
// - 多 chunk 從尾部倒序套用（避免 offset 漂移——codex apply_replacements 同款）
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
      if (ctxIndex === -1) return { error: `context line not found after offset ${lineIndex}: ${JSON.stringify(ctx)}` }
      lineIndex = ctxIndex + 1
    }
    const old = chunk.oldLines
    if (old.length === 0) {
      // 純插入：一律附尾（chunk 含 isEndOfFile 或無 old 皆插檔尾——codex 同款）
      replacements.push({ index: lines.length, oldLen: 0, newLines: chunk.newLines })
      continue
    }
    const found = findLines(lines, old, lineIndex)
    if (found === -1) return { error: `expected lines not found near line ${lineIndex + 1}: ${JSON.stringify(old.slice(0, 3))}...` }
    if (chunk.isEndOfFile && found + old.length < lines.length) {
      return { error: `end-of-file chunk matched at line ${found + 1}, not the end of file: ${JSON.stringify(old.slice(0, 3))}...` }
    }
    replacements.push({ index: found, oldLen: old.length, newLines: chunk.newLines })
    lineIndex = found + old.length
  }
  // 倒序套用前，先依 index「穩定」排序（tie-break：相等 index 保持記錄序）：
  // 記錄順 ≠ 文件序——純插入一律記在 index=lines.length（EOF），若它在補丁中先出現、
  // 後面還有指向較早行號的 replace chunk，直接 reverse 會把插入 splice 到錯位置
  // （例：append 記 idx2、replace 記 idx0；倒序＝先 splice(0)、再 splice(2)，插入落到改寫後的中間）。
  // ES2019 起 native sort 為 stable → 相等 index（兩個純插入）維持記錄序，倒序後仍按原相對次序落地。
  const ordered = [...replacements].sort((x, y) => x.index - y.index)
  let result = [...lines]
  for (const r of [...ordered].reverse()) {
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
        // fail-closed：Add 到已存在路徑＝静默破壞性覆寫 → 先 stat，存在即報錯且不寫入
        const existing = await stat(target).catch(() => null)
        if (existing !== null) {
          throw new FsToolError("FS_ALREADY_EXISTS", `Add File: target already exists: ${hunk.path}`)
        }
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
        // TOCTOU 防護（M21 §4.2，edit tool 同款）：read 後、計算/寫回前 re-stat
        // 比對 {mtimeMs,size} 快照——read 與寫入之間檔案被併發修改即拒絕。
        // mismatch → throw，由外層收集進 errors 並停止。
        let stAfter
        try {
          stAfter = await stat(target)
        } catch {
          throw new FsToolError("FS_NOT_FOUND", `file disappeared during update: ${hunk.path}`)
        }
        assertSnapshotFresh({ mtimeMs: st.mtimeMs, size: st.size }, { mtimeMs: stAfter.mtimeMs, size: stAfter.size })
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
