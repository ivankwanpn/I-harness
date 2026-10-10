import type { ExecutionOutput } from "@i-harness/sandbox"

export interface NativeError {
  code: string; api: string; nativeCode: number | null; detail: string; cleanup: NativeError[]
}
export type Status = { version: 1; id: string; type: string; [key: string]: unknown }

export class StatusDecoder {
  private tail = Buffer.alloc(0)
  push(chunk: Buffer): Status[] {
    this.tail = Buffer.concat([this.tail, chunk])
    const result: Status[] = []
    for (;;) {
      const end = this.tail.indexOf(10)
      if (end < 0) break
      if (end > 65536) throw new Error("Helper status line exceeds 65536 bytes")
      const line = this.tail.subarray(0, end)
      this.tail = this.tail.subarray(end + 1)
      let value: unknown
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) }
      catch { throw new Error("Invalid helper status JSON") }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid helper status object")
      const status = value as Status
      if (status.version !== 1 || typeof status.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(status.id)
        || typeof status.type !== "string") throw new Error("Invalid helper status version, ID or type")
      result.push(status)
    }
    if (this.tail.length > 65536) throw new Error("Helper status line exceeds 65536 bytes")
    return result
  }
  finish(): void { if (this.tail.length) throw new Error("Incomplete helper status line") }
}

export class FrameDecoder {
  private tail = Buffer.alloc(0)
  private ended = false
  get outputEnded(): boolean { return this.ended }
  push(chunk: Buffer): ExecutionOutput[] {
    if (this.ended && chunk.length) throw new Error("Binary data after output-end")
    this.tail = Buffer.concat([this.tail, chunk])
    const result: ExecutionOutput[] = []
    while (this.tail.length >= 5) {
      const channel = this.tail[0]!
      const length = this.tail.readUInt32LE(1)
      if (channel > 3 || (channel === 3 ? length !== 0 : length < 1 || length > 16384)) {
        throw new Error("Invalid helper output frame")
      }
      if (this.tail.length < 5 + length) break
      const payload = this.tail.subarray(5, 5 + length)
      this.tail = this.tail.subarray(5 + length)
      if (channel === 3) {
        this.ended = true
        if (this.tail.length) throw new Error("Binary data after output-end")
      } else result.push({ channel: (["stdout", "stderr", "pty"] as const)[channel]!, data: Buffer.from(payload) })
    }
    return result
  }
  finish(outputAbandoned: boolean): void {
    if (!outputAbandoned && (this.tail.length || !this.ended)) throw new Error("Incomplete helper output")
    this.tail = Buffer.alloc(0)
  }
}
