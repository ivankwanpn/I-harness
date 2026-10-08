/** The control pipe is owned by the trusted worker. Workload bytes occur only in base64 output frames. */
export const MAX_LINE_BYTES = 256 * 1024
export const MAX_CHUNK_BYTES = 32 * 1024

export type WorkerFrame =
  | { type: "hello"; sha256: string; workerPid: number }
  | { type: "probe"; available: boolean; detail: string }
  | { type: "prepared"; policyFingerprint: string }
  | { type: "started"; pid: number }
  | { type: "output"; channel: "stdout" | "stderr"; data: string }
  | { type: "root"; exitCode: number | null; signal?: string }
  | { type: "settled" }
  | { type: "refused"; detail: string }
  | { type: "error"; detail: string }
export type HostType = "probe" | "prepare" | "commit" | "cancel" | "input" | "endInput" | "shutdown"
type Phase = "hello" | "ready" | "probing" | "probed" | "preparing" | "prepared" | "committing" | "running" | "root" | "refused" | "settled" | "failed"

export class FrameDecoder {
  private pending = Buffer.alloc(0)
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true })
  feed(data: Uint8Array): unknown[] {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const frames: unknown[] = []
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline === -1 ? bytes.length : newline
      if (this.pending.length + end - start + 1 > MAX_LINE_BYTES) throw new Error("Worker frame exceeds line limit")
      const part = bytes.subarray(start, end)
      if (newline === -1) {
        this.pending = Buffer.concat([this.pending, part])
        break
      }
      const line = this.pending.length ? Buffer.concat([this.pending, part]) : part
      this.pending = Buffer.alloc(0)
      try { frames.push(JSON.parse(this.utf8.decode(line))) }
      catch { throw new Error("Malformed worker JSON frame") }
      start = end + 1
    }
    return frames
  }
  end(): void { if (this.pending.length) throw new Error("Worker pipe ended with a truncated frame") }
}

export function decodeBase64(value: string): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4)
    throw new Error("Worker output exceeds chunk limit")
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Malformed worker base64")
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value) throw new Error("Noncanonical worker base64")
  if (bytes.length > MAX_CHUNK_BYTES) throw new Error("Worker output exceeds chunk limit")
  return bytes
}

const positivePid = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
const shortText = (value: unknown) => typeof value === "string" && value.length <= 4096 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)

export class WorkerProtocol {
  phase: Phase = "hello"
  private stopping = false
  constructor(private readonly nonce: string, private readonly digest: string) {}

  send(type: HostType): void {
    const invalid = () => { throw new Error(`Invalid host ${type} in worker phase ${this.phase}`) }
    switch (type) {
      case "probe": if (this.phase !== "ready" || this.stopping) invalid(); this.phase = "probing"; break
      case "prepare": if (this.phase !== "ready" || this.stopping) invalid(); this.phase = "preparing"; break
      case "commit": if (this.phase !== "prepared" || this.stopping) invalid(); this.phase = "committing"; break
      case "input": case "endInput": if (this.phase !== "running" || this.stopping) invalid(); break
      case "cancel": case "shutdown": this.stopping = true; break
    }
  }

  receive(value: unknown): WorkerFrame {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed worker frame")
    const f = value as Record<string, unknown>
    if (f.v !== 1 || f.nonce !== this.nonce) throw new Error("Worker protocol version or nonce mismatch")
    const phase = (...allowed: Phase[]) => {
      if (!allowed.includes(this.phase)) throw new Error(`Invalid worker ${String(f.type)} in phase ${this.phase}`)
    }
    const fields = (...names: string[]) => {
      if (Object.keys(f).some(key => !["v", "nonce", "type", ...names].includes(key))) throw new Error("Unknown worker frame field")
    }
    switch (f.type) {
      case "hello":
        phase("hello"); fields("sha256", "workerPid")
        if (f.sha256 !== this.digest || !positivePid(f.workerPid)) throw new Error("Worker bootstrap identity mismatch")
        this.phase = "ready"; break
      case "probe":
        phase("probing"); fields("available", "detail")
        if (typeof f.available !== "boolean" || !shortText(f.detail)) throw new Error("Invalid worker probe")
        this.phase = "probed"; break
      case "prepared":
        phase("preparing"); fields("policyFingerprint")
        if (!shortText(f.policyFingerprint) || !f.policyFingerprint) throw new Error("Invalid worker policy fingerprint")
        this.phase = "prepared"; break
      case "started":
        phase("committing"); fields("pid")
        if (!positivePid(f.pid)) throw new Error("Invalid worker launcher PID")
        this.phase = "running"; break
      case "output":
        phase("running", "root"); fields("channel", "data")
        if (f.channel !== "stdout" && f.channel !== "stderr") throw new Error("Invalid output channel")
        decodeBase64(f.data as string); break
      case "root":
        phase("running"); fields("exitCode", "signal")
        if (f.exitCode !== null && (!Number.isSafeInteger(f.exitCode) || (f.exitCode as number) < 0 || (f.exitCode as number) > 255))
          throw new Error("Invalid root exit code")
        if (f.signal !== undefined && (typeof f.signal !== "string" || !/^[A-Z][A-Z0-9]{0,15}$/.test(f.signal))) throw new Error("Invalid root signal")
        this.phase = "root"; break
      case "settled":
        if (this.stopping) phase("preparing", "prepared", "root", "refused")
        else phase("root", "refused")
        fields(); this.phase = "settled"; break
      case "refused":
        phase("preparing", "committing"); fields("detail")
        if (!shortText(f.detail) || !f.detail) throw new Error("Invalid worker refusal detail")
        this.phase = "refused"; break
      case "error":
        if (this.phase === "failed" || this.phase === "settled") throw new Error("Invalid worker error phase")
        fields("detail")
        if (!shortText(f.detail)) throw new Error("Invalid worker error detail")
        this.phase = "failed"; break
      default: throw new Error("Unknown worker frame type")
    }
    return f as unknown as WorkerFrame
  }
}
