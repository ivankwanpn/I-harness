import { statSync } from "node:fs"
import { loadInstructionFiles, renderInstructions, type InstructionFile } from "./files.ts"

export { loadInstructionFiles, renderInstructions, discoverInstructionPaths } from "./files.ts"
export type { InstructionFile } from "./files.ts"

export interface InstructionsConfig { workspace: string; maxBytes?: number }

export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 24_000

interface Cached {
  mtimeMs: number
  size: number
  content: InstructionFile[]
}

// R-A5: mount as one of runtime-context's dynamic sections (Task 6). The
// getter is SYNCHRONOUS (the pre-step render seam is sync): it re-stats cached
// files and re-reads only when mtime/size changed, so an unchanged tree costs
// one stat per file per step boundary (cheap; change detection is the
// mtime/size compare — the roadmap's "變更檢測可後補" note is covered by the
// snapshot-diff dedupe in runtime-context).
export function createInstructionsSection(config: InstructionsConfig): () => string {
  const maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES
  let cache: { key: string; files: Cached } | undefined

  function readChanged(): InstructionFile[] {
    const files = loadInstructionFiles(config.workspace)
    const key = files.map((f) => f.absolutePath).join("|")
    const filesNow: Cached = { mtimeMs: 0, size: 0, content: files }
    try {
      const stats = files.map((f) => statSync(f.absolutePath))
      filesNow.mtimeMs = Math.max(...stats.map((s) => s.mtimeMs), 0)
      filesNow.size = stats.reduce((acc, s) => acc + s.size, 0)
    } catch {
      // stat failure → fall through to full re-read on the next call
    }
    if (cache !== undefined && cache.key === key && cache.files.mtimeMs === filesNow.mtimeMs && cache.files.size === filesNow.size) {
      return cache.files.content
    }
    cache = { key, files: filesNow }
    return filesNow.content
  }

  return () => {
    const files = readChanged()
    let text = renderInstructions(files)
    if (text.length > maxBytes) {
      text = text.slice(0, maxBytes) + "(truncated)"
    }
    return text
  }
}
