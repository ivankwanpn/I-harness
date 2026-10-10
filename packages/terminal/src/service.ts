import { StringDecoder } from "node:string_decoder"
import { resolve } from "node:path"
import { currentExecCaller, withExecCallerScope, type ExecService, type SupervisedExecution } from "@i-harness/exec"
import type { ExecutionOwner, ExecutionSettlement, RootExit, SandboxExecutionPolicy } from "@i-harness/sandbox"

export interface TerminalOpenSpec {
  /** Preserve CR/LF and control sequences for terminal emulators. */
  rawOutput?: boolean
  command: string
  args?: string[]
  cwd?: string
  /** Omission inherits the host snapshot; an explicit empty object stays empty. */
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** Resolved by trusted tool/host policy, never by model JSON. */
  sandbox?: SandboxExecutionPolicy
}
export type TerminalSignalName = "INT" | "TERM" | "KILL"
export interface TerminalView {
  id: string
  command: string
  pid: number
  status: "running" | "exited"
  exitCode?: number
  cols: number
  rows: number
  beganAt: string
  ownerSessionId?: string
  /** Root exit and full native settlement are separate observations. */
  root?: RootExit
  settlement?: ExecutionSettlement
  cleanupDetail?: string
  outputDiagnostics?: { outputAbandoned: boolean; discardedOutputBytes: number }
}
export interface TerminalRunSpec { id: string; pid: number; cols: number; rows: number }
export interface TerminalReadResult {
  dropped?: boolean
  id: string
  data: string
  nextOffset: number
  truncated: boolean
  status: TerminalView["status"]
  exitCode?: number
}
export interface TerminalService {
  open(spec: TerminalOpenSpec, opts?: { sessionId?: string; abortSignal?: AbortSignal }): Promise<TerminalRunSpec>
  send(id: string, data: string, opts?: { sessionId?: string; sandbox?: SandboxExecutionPolicy }): Promise<void>
  read(id: string, opts?: { offset?: number; maxBytes?: number; sessionId?: string }): TerminalReadResult
  signal(id: string, signal: TerminalSignalName, opts?: { sessionId?: string }): Promise<TerminalView>
  close(id: string, opts?: { sessionId?: string }): Promise<TerminalView>
  resize(id: string, cols: number, rows: number, opts?: { sessionId?: string }): Promise<TerminalView>
  list(opts?: { sessionId?: string }): TerminalView[]
  waitExited(id: string): Promise<{ exitCode?: number }>
  dispose(): Promise<void>
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_MAX_READ_BYTES = 64_000
const RING_MAX = 1_000_000

class TerminalRecord {
  static counter = 0
  readonly id = `term-${++TerminalRecord.counter}`
  readonly beganAt = new Date().toISOString()
  readonly owner: Readonly<ExecutionOwner>
  readonly decoder = new StringDecoder("utf8")
  private pendingCR = false
  readonly chunks: string[] = []
  retainedLength = 0
  startOffset = 0
  cols: number
  rows: number
  status: "running" | "exited" = "running"
  exitCode?: number
  root?: RootExit
  settlement?: ExecutionSettlement
  cleanupDetail?: string
  outputFailure?: string
  outputDone: Promise<void>

  constructor(readonly spec: TerminalOpenSpec, readonly execution: SupervisedExecution) {
    this.owner = execution.policy.owner
    this.cols = spec.cols ?? DEFAULT_COLS
    this.rows = spec.rows ?? DEFAULT_ROWS
    this.outputDone = this.consume()
    void this.outputDone.catch(cause => { this.outputFailure = String(cause) })
    void execution.handle.rootExited.then(root => {
      this.root = root
      this.status = "exited"
      if (root.exitCode !== null) this.exitCode = root.exitCode
    }, cause => { this.outputFailure = String(cause) })
    void execution.handle.settled.then(settlement => {
      this.settlement = settlement
      if (settlement.kind === "incomplete") this.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      else this.cleanupDetail = undefined
    }, cause => { this.cleanupDetail = String(cause) })
  }

  private append(data: string): void {
    if (this.spec.rawOutput) { this.appendRetained(data); return }
    const combined = (this.pendingCR ? "\r" : "") + data
    this.pendingCR = combined.endsWith("\r")
    const complete = this.pendingCR ? combined.slice(0, -1) : combined
    this.appendRetained(complete.replace(/\r\n/g, "\n"))
  }

  private appendRetained(cleaned: string): void {
    if (!cleaned) return
    const last = this.chunks.length - 1
    if (last >= 0 && this.chunks[last]!.length < 4096 && cleaned.length < 4096) this.chunks[last] += cleaned
    else this.chunks.push(cleaned)
    this.retainedLength += cleaned.length
    while (this.retainedLength > RING_MAX) {
      const first = this.chunks[0]!
      const remove = Math.min(first.length, this.retainedLength - RING_MAX)
      if (remove === first.length) this.chunks.shift()
      else this.chunks[0] = first.slice(remove)
      this.retainedLength -= remove
      this.startOffset += remove
    }
  }

  private async consume(): Promise<void> {
    for await (const frame of this.execution.handle.io.output) {
      if (frame.channel !== "pty") throw new Error("PTY backend returned non-PTY output")
      this.append(this.decoder.write(Buffer.from(frame.data)))
    }
    const tail = this.decoder.end()
    if (tail) this.append(tail)
    if (this.pendingCR) { this.pendingCR = false; this.appendRetained("\r") }
  }

  textSince(offset: number): string {
    const combined = this.chunks.join("")
    const relative = Math.max(0, offset - this.startOffset)
    return relative >= combined.length ? "" : combined.slice(relative)
  }
}

/** The only process owner is ExecService. This service keeps presentation views. */
export function createTerminalService(exec: ExecService): TerminalService {
  const records = new Map<string, TerminalRecord>()
  const pending = new Set<{ controller: AbortController; attempt: Promise<TerminalRunSpec> }>()
  let disposed = false

  function getOwned(id: string, sessionId?: string): TerminalRecord {
    const record = records.get(id)
    if (!record) throw new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)
    // Standalone callers can use their local default owner without an ALS
    // scope. Named owners require a trusted dispatch scope or owner assertion.
    const caller = currentExecCaller()?.sessionId ?? sessionId ?? (record.owner.sessionId === "standalone-exec" ? "standalone-exec" : undefined)
    if (caller !== record.owner.sessionId || (sessionId !== undefined && sessionId !== record.owner.sessionId)) {
      throw new Error(`TERMINAL_OWNER_MISMATCH: terminal ${id} is owned by session ${record.owner.sessionId}`)
    }
    return record
  }

  function view(record: TerminalRecord): TerminalView {
    return {
      id: record.id, command: record.spec.command, pid: record.execution.handle.pid,
      status: record.status, ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      cols: record.cols, rows: record.rows, beganAt: record.beganAt,
      ownerSessionId: record.owner.sessionId,
      ...(record.root === undefined ? {} : { root: record.root }),
      ...(record.settlement === undefined ? {} : { settlement: record.settlement }),
      ...(record.cleanupDetail === undefined ? {} : { cleanupDetail: record.cleanupDetail }),
      ...(record.execution.handle.io.diagnostics?.() === undefined ? {} : { outputDiagnostics: record.execution.handle.io.diagnostics?.() }),
    }
  }

  async function stop(record: TerminalRecord): Promise<ExecutionSettlement> {
    let settlement: ExecutionSettlement
    try {
      settlement = await withExecCallerScope(record.owner, () => exec.cancelExecution(record.execution.id, "cancelled"))
    } catch (cause) {
      // A naturally settled handle can retire before the output/view observer.
      settlement = await record.execution.handle.settled
      if (settlement.kind !== "settled") {
        record.cleanupDetail = cause instanceof Error ? cause.message : String(cause)
        throw cause
      }
    }
    record.settlement = settlement
    if (settlement.kind !== "settled") {
      record.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      throw new Error(`Terminal cleanup incomplete: ${record.cleanupDetail}`)
    }
    await record.outputDone
    record.cleanupDetail = undefined
    return settlement
  }

  return {
    open(spec, opts) {
      if (disposed) throw new Error("terminal service disposed")
      const controller = new AbortController()
      const externalAbort = () => controller.abort(opts?.abortSignal?.reason ?? "cancelled")
      opts?.abortSignal?.addEventListener("abort", externalAbort, { once: true })
      if (opts?.abortSignal?.aborted) externalAbort()
      const attempt = (async (): Promise<TerminalRunSpec> => {
      if (!spec.command) throw new Error("Terminal command required")
      const cols = spec.cols ?? DEFAULT_COLS
      const rows = spec.rows ?? DEFAULT_ROWS
      if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid terminal dimensions")
      const env = spec.env === undefined ? undefined : { ...spec.env }
      const cwd = resolve(spec.cwd ?? process.cwd())
      // node-pty on POSIX requires these exact values. Bind them as host intent
      // before ExecService captures its immutable environment; explicit env is
      // retained exactly and must provide them itself.
      if (process.platform !== "win32" && env === undefined) {
        const inherited = { ...process.env, PWD: cwd, TERM: process.env.TERM || "xterm-256color" } as Record<string, string>
        Object.keys(inherited).forEach(key => inherited[key] === undefined && delete inherited[key])
        spec = { ...spec, env: inherited }
      }
      const presentationSpec: TerminalOpenSpec = { ...spec,
        ...(spec.args === undefined ? {} : { args: [...spec.args] }),
        ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
      }
      const execution = await exec.launchTransport({
        argv: [spec.command, ...(spec.args ?? [])], cwd,
        ...(spec.env === undefined ? {} : { env: spec.env }),
        transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt",
        pty: { cols, rows }, ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
        abortSignal: controller.signal,
      })
      // The receipt is the authority; an optional trusted dispatch assertion
      // cannot select an owner or change the already admitted execution.
      if (disposed || (opts?.sessionId !== undefined && opts.sessionId !== execution.policy.owner.sessionId)) {
        const abandoned = new TerminalRecord(presentationSpec, execution)
        records.set(abandoned.id, abandoned)
        await stop(abandoned)
        records.delete(abandoned.id)
        throw new Error(disposed ? "terminal service disposed during admission" : "TERMINAL_OWNER_MISMATCH: caller differs from admitted owner")
      }
      const record = new TerminalRecord(presentationSpec, execution)
      records.set(record.id, record)
      return { id: record.id, pid: execution.handle.pid, cols, rows }
      })()
      const entry = { controller, attempt }
      pending.add(entry)
      void attempt.finally(() => { pending.delete(entry); opts?.abortSignal?.removeEventListener("abort", externalAbort) }).catch(() => {})
      return attempt
    },
    async send(id, data, opts) {
      const record = getOwned(id, opts?.sessionId)
      const rank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 }
      if (rank[opts?.sandbox?.mode ?? "danger-full-access"] < rank[record.execution.policy.mode]) {
        throw new Error(`TERMINAL_POLICY_MISMATCH: terminal ${id} was admitted under ${record.execution.policy.mode}`)
      }
      if (record.status === "exited") throw new Error(`Terminal ${id} has exited`)
      const bytes = Buffer.from(data)
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        await record.execution.handle.io.write(bytes.subarray(offset, Math.min(offset + 16_384, bytes.length)))
      }
    },
    read(id, opts) {
      const record = getOwned(id, opts?.sessionId)
      const offset = opts?.offset ?? 0
      const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid terminal cursor")
      const text = record.textSince(offset)
      const data = text.slice(0, maxBytes)
      return { id, data, nextOffset: Math.max(offset, record.startOffset) + data.length,
        ...(offset < record.startOffset ? { dropped: true } : {}), truncated: text.length > data.length,
        status: record.status, ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }) }
    },
    async signal(id, signal, opts) {
      const record = getOwned(id, opts?.sessionId)
      if (signal === "INT") {
        if (record.status === "running") {
          if (record.execution.handle.io.signal) await record.execution.handle.io.signal("INT")
          else await record.execution.handle.io.write(Buffer.from("\x03"))
        }
      } else await stop(record)
      return view(record)
    },
    async close(id, opts) {
      const record = getOwned(id, opts?.sessionId)
      await stop(record)
      const final = view(record)
      records.delete(id)
      return final
    },
    async resize(id, cols, rows, opts) {
      const record = getOwned(id, opts?.sessionId)
      if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid terminal dimensions")
      if (record.status === "running") {
        if (!record.execution.handle.io.resize) throw new Error("PTY resize unsupported by selected backend")
        await record.execution.handle.io.resize(cols, rows)
      }
      record.cols = cols
      record.rows = rows
      return view(record)
    },
    list(opts) {
      if (currentExecCaller() && opts?.sessionId !== undefined && currentExecCaller()!.sessionId !== opts.sessionId) {
        throw new Error("TERMINAL_OWNER_MISMATCH: caller scope differs from terminal list owner")
      }
      const owner = currentExecCaller()?.sessionId ?? opts?.sessionId
      return [...records.values()].filter(record => owner === undefined || record.owner.sessionId === owner).map(view)
    },
    async waitExited(id) {
      const record = records.get(id)
      if (!record) throw new Error(`TERMINAL_NOT_FOUND: no terminal ${id}`)
      const root = await record.execution.handle.rootExited
      return root.exitCode === null ? {} : { exitCode: root.exitCode }
    },
    async dispose() {
      disposed = true
      const admissions = [...pending]
      const existing = [...records.values()]
      admissions.forEach(entry => entry.controller.abort("shutdown"))
      const admissionOutcomes = await Promise.allSettled(admissions.map(entry => entry.attempt))
      const outcomes = await Promise.allSettled(existing.map(async record => {
        await stop(record)
        records.delete(record.id)
      }))
      const failures = [
        ...admissionOutcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
          && (outcome.reason instanceof AggregateError || /cleanup incomplete|cleanup failed/i.test(String(outcome.reason)))),
        ...outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"),
      ]
      if (failures.length) throw new AggregateError(failures.map(item => item.reason), "Terminal view disposal incomplete")
    },
  }
}
