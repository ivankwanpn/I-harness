import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { createSpillStore, createTextRetainer, spillNotice, type SpillStore } from "./index.ts"

export interface OutputSpillGuardConfig {
  maxOutputBytes?: number   // 缺省 64_000
  spillRoot?: string        // 缺省 <tmpdir>/i-harness-spill（穩定目錄——GC 有意義）
  gc?: { maxAgeMs?: number; maxTotalBytes?: number } // 缺省 24h / 512MiB
}

const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const DEFAULT_MAX_AGE_MS = 86_400_000
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** registry 級統一落盤（opencode/dsh spill policy 吸收）。string 超限 → 截斷字串 + spill notice
 *  （notice 內含完整路徑）；object 超限 → { output, outputPaths, spill } 信封。**core-tools 零改動**
 *  ——core-tools 的 tools/execute cascade 縫（guard-timeout 先例）是唯一接入點。 */
export function createOutputSpillGuard(_ctx: PluginContext, config?: OutputSpillGuardConfig): Plugin {
  const maxBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const root = config?.spillRoot ?? join(tmpdir(), "i-harness-spill")
  const store: SpillStore = createSpillStore({ root })
  // 掛載時跑一次 GC（best-effort；失敗只 warn——GC 是維生屋事，不阻擋掛載）
  const gcOpts = { maxAgeMs: config?.gc?.maxAgeMs ?? DEFAULT_MAX_AGE_MS, maxTotalBytes: config?.gc?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES }
  void gcSpillStore(root, gcOpts).catch((e) => console.warn(`[i-harness] spill GC failed: ${String(e)}`))

  return {
    name: "output-spill",
    mount(ctx: PluginContext): void {
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const out = await next()
        if (out === undefined || out === null || typeof out === "number" || typeof out === "boolean") return out
        const d = dispatch as { name: string }
        if (typeof out === "string") {
          if (Buffer.byteLength(out, "utf-8") <= maxBytes) return out
          const r = createTextRetainer({ maxBytes, mode: "headTail" })
          r.push(out)
          const kept = r.finish()
          const path = await store.saveText(out, `${d.name}-output`)
          return kept.text + "\n" + spillNotice(kept.omittedBytes, path)
        }
        const json = JSON.stringify(out)
        if (Buffer.byteLength(json, "utf-8") <= maxBytes) return out
        const r = createTextRetainer({ maxBytes, mode: "headTail" })
        r.push(json)
        const kept = r.finish()
        const path = await store.saveText(json, `${d.name}-output`)
        return {
          output: kept.text + "\n" + spillNotice(kept.omittedBytes, path),
          outputPaths: [path],
          spill: { omittedBytes: kept.omittedBytes, label: d.name },
        }
      })
    },
  }
}

/** GC：刪 maxAgeMs 前的檔案（mtime），再按總量修剪——最舊先刪。回報刪除數/位元組。 */
export async function gcSpillStore(
  root: string,
  opts: { maxAgeMs: number; maxTotalBytes: number; now?: number },
): Promise<{ removedFiles: number; removedBytes: number }> {
  const { readdir, stat, unlink } = await import("node:fs/promises")
  const now = opts.now ?? Date.now()
  const entries: Array<{ path: string; mtime: number; size: number }> = []
  for (const name of await readdir(root)) {
    try {
      const st = await stat(join(root, name))
      if (st.isFile()) entries.push({ path: join(root, name), mtime: st.mtimeMs, size: st.size })
    } catch { /* 競態刪除中——跳過 */ }
  }
  let removedBytes = 0
  let removedFiles = 0
  const remaining: typeof entries = []
  for (const e of entries) {
    if (now - e.mtime > opts.maxAgeMs) { removedFiles++; removedBytes += e.size; await unlink(e.path).catch(() => {}) }
    else remaining.push(e)
  }
  remaining.sort((a, b) => a.mtime - b.mtime) // 最舊先
  let total = remaining.reduce((s, e) => s + e.size, 0)
  for (const e of remaining) {
    if (total <= opts.maxTotalBytes) break
    total -= e.size
    removedFiles++; removedBytes += e.size
    await unlink(e.path).catch(() => {})
  }
  return { removedFiles, removedBytes }
}

export function createUnifiedSpillStore(root?: string): SpillStore {
  return createSpillStore({ root: root ?? join(tmpdir(), "i-harness-spill") })
}
