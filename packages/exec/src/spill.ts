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
  private chunks: Buffer[] = [] // 溢出前：全部；溢出後：tail（last maxBytes）
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
    // tail-keep 內存（單一 chunk > maxBytes 時整 chunk 保留——chunks.length > 1 才 drop）
    this.chunks.push(chunk)
    this.tailBytes += chunk.byteLength
    while (this.tailBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.tailBytes -= dropped.byteLength
    }
    // 超 spill cap → discard（close + unlink + 永久停用）→ 只剩 tail
    if (!this.spillDisabled && this.spillFd !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
    }
  }

  finalize(): CollectResult {
    const text = Buffer.concat(this.chunks).toString("utf-8")
    const truncated = this.total > this.maxBytes
    const spillPath = this.spillPath
    // 有完整 spill 檔 → 資料無損（lossy=false）；無 spill 檔（discard/開檔失敗）且 truncated → 中間丟（lossy=true）
    const lossy = truncated && spillPath === undefined
    if (this.spillFd !== undefined) {
      closeSync(this.spillFd)
      this.spillFd = undefined
    }
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
    try {
      writeSync(this.spillFd, chunk)
    } catch {
      this.discardSpill()
    }
  }

  private discardSpill(): void {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {}
      this.spillFd = undefined
    }
    if (this.spillPath) {
      try {
        unlinkSync(this.spillPath)
      } catch {}
    }
    this.spillPath = undefined
    this.spillDisabled = true
  }
}

function encodeSegment(s: string): string {
  // injective 安全段編碼（吸收 dsh encodeSegment）：[A-Za-z0-9._-] 原樣（含 .），其餘 → ~<hex>
  let out = ""
  for (const ch of s) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else out += `~${ch.codePointAt(0)!.toString(16)}`
  }
  return out || "~"
}
