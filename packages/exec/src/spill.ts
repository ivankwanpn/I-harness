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
    if (!this.spillDisabled && this.total > this.maxSpillBytes) this.discardSpill()
    // 溢出判定（spill 已停用時不重啟）
    if (!this.spillDisabled && (this.spillFd === undefined ? this.total > this.maxBytes : true)) {
      if (this.spillFd === undefined) {
        this.openSpill()
        // 溢出當下把 retained 全寫（完整 stream）
        for (const c of this.chunks) this.writeSpill(c)
      }
      this.writeSpill(chunk)
    }
    // Copy retained slices so a small tail cannot retain a large backing buffer.
    const retained = Buffer.from(chunk.subarray(Math.max(0, chunk.length - this.maxBytes)))
    if (retained.length) this.chunks.push(retained)
    this.tailBytes += retained.byteLength
    while (this.tailBytes > this.maxBytes) {
      const first = this.chunks[0]!
      const excess = this.tailBytes - this.maxBytes
      if (first.length <= excess) {
        this.chunks.shift()
        this.tailBytes -= first.length
      } else {
        this.chunks[0] = Buffer.from(first.subarray(excess))
        this.tailBytes -= excess
      }
    }
    // 超 spill cap → discard（close + unlink + 永久停用）→ 只剩 tail
    if (!this.spillDisabled && this.spillFd !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
    }
  }

  finalize(): CollectResult {
    if (this.spillFd !== undefined) {
      closeSync(this.spillFd)
      this.spillFd = undefined
    }
    return this.snapshot()
  }

  snapshot(): CollectResult {
    const text = this.peek()
    const truncated = this.total > this.maxBytes
    const spillPath = this.spillPath
    // 有完整 spill 檔 → 資料無損（lossy=false）；無 spill 檔（discard/開檔失敗）且 truncated → 中間丟（lossy=true）
    const lossy = truncated && spillPath === undefined
    return { text, spillPath, lossy, truncated }
  }

  /** Current bounded presentation, without closing the ongoing spill. */
  peek(): string {
    const bytes = Buffer.concat(this.chunks)
    let start = 0
    if (this.total > this.maxBytes) while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
    const text = new TextDecoder().decode(bytes.subarray(start), { stream: true })
    // Invalid binary bytes can expand to UTF-8 replacement characters.
    const encoded = Buffer.from(text)
    start = Math.max(0, encoded.length - this.maxBytes)
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++
    return encoded.subarray(start).toString("utf8")
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
