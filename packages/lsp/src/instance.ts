// LSP instance: initialize handshake + transient didOpen lifecycle with a
// serialized abortable query queue + bounded teardown (shutdown → exit →
// grace → kill).
import type { ConnectionSpec } from "./connection.ts"
import { spawnLspConnection, type LspConnection } from "./connection.ts"

export interface InstanceSpec extends ConnectionSpec {
  initializeOptions?: unknown
  /** Bound for the shutdown request during dispose (a hung request is treated as "shutdown failed"). */
  shutdownTimeoutMs: number
}

export type LspOperation = "goToDefinition" | "findReferences" | "hover"

export interface LspQuery {
  operation: LspOperation
  filePath: string
  line: number        // 1-based
  character: number   // 1-based UTF-16
}

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspHover { contents: string; range?: LspRange }
/** A diagnostic as reported by a language server (textDocument/diagnostic).
 *  Ranges stay 0-based LSP coordinates; the 1-based conversion happens at render time. */
export interface LspDiagnostic {
  range: LspRange
  severity?: number
  message: string
  source?: string
  code?: string
}

export type LspQueryResult =
  | { kind: "locations"; locations: LspLocation[] }
  | { kind: "empty" }
  | { kind: "hover"; hover: LspHover | null }

const OP_TO_METHOD: Record<LspOperation, string> = {
  goToDefinition: "textDocument/definition",
  findReferences: "textDocument/references",
  hover: "textDocument/hover",
}

const OP_TO_CAPABILITY: Record<LspOperation, keyof { definitionProvider: unknown; referencesProvider: unknown; hoverProvider: unknown }> = {
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  hover: "hoverProvider",
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPos(v: unknown): v is LspPosition {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.line === "number" && typeof p.character === "number"
}

/** textDocument/diagnostic wire result → LspDiagnostic[]: unwrap `{ items }`
 *  (null/undefined → []; plain array → as-is); keep entries with a string
 *  message and a well-formed range, discarding the rest (fail-closed). */
export function normalizeDiagnostics(payload: unknown): LspDiagnostic[] {
  const items = Array.isArray(payload) ? payload : (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  const out: LspDiagnostic[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const d = item as Record<string, unknown>
    if (typeof d.message !== "string") continue
    const range = d.range
    if (typeof range !== "object" || range === null) continue
    const r = range as Record<string, unknown>
    if (!isPos(r.start) || !isPos(r.end)) continue
    out.push({
      range: { start: r.start, end: r.end },
      ...(typeof d.severity === "number" ? { severity: d.severity } : {}),
      message: d.message,
      ...(typeof d.source === "string" ? { source: d.source } : {}),
      ...(typeof d.code === "string" ? { code: d.code } : {}),
    })
  }
  return out
}

export class LspInstance {
  private readonly conn: LspConnection
  private readonly shutdownTimeoutMs: number
  private readonly killGraceMs: number
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()
  readonly ready: Promise<void>

  constructor(spec: InstanceSpec, spawner?: (s: ConnectionSpec) => ReturnType<typeof import("node:child_process").spawn>) {
    this.conn = spawnLspConnection(spec, spawner)
    this.shutdownTimeoutMs = spec.shutdownTimeoutMs
    this.killGraceMs = spec.killGraceMs
    this.ready = this.initialize(spec.initializeOptions)
  }

  private async initialize(initOptions: unknown): Promise<void> {
    const result = await this.conn.request("initialize", {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      ...(initOptions !== undefined ? { initializationOptions: initOptions } : {}),
    })
    this.capabilities = (result as { capabilities?: Record<string, unknown> }).capabilities ?? {}
    await this.conn.notify("initialized", {})
  }

  private capabilities: Record<string, unknown> = {}

  /** Query the server with a transient didOpen → request → didClose lifecycle.
   *  Queries are serialized (spec §3.4: one query at a time, abortable); a failed
   *  query does not stall later ones. */
  query(query: LspQuery, source: string, signal?: AbortSignal): Promise<LspQueryResult> {
    const run = () => this.doQuery(query, source, signal)
    const next = this.queue.then(run, run) // continuation form: rejections never break the chain
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Pull ALL diagnostics for a file (textDocument/diagnostic) with the same
   *  transient didOpen → request → didClose lifecycle and the same serialized
   *  queue as query() (one at a time, abortable). No position params: the
   *  tool-side cursor filter happens in packages/lsp/src/tools.ts. */
  diagnostics(filePath: string, source: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    const run = () => this.doDiagnostics(filePath, source, signal)
    const next = this.queue.then(run, run) // continuation form: rejections never break the chain
    this.queue = next.catch(() => undefined)
    return next
  }

  private async doDiagnostics(filePath: string, source: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    if (this.disposed) throw new Error("LSP instance was disposed")
    const uri = this.fileUri(filePath)
    return this.withOpenDocument(uri, filePath, source, async () => {
      const result = await this.conn.request("textDocument/diagnostic", { textDocument: { uri } }, signal)
      return normalizeDiagnostics(result)
    })
  }

  /** Shared transient didOpen → fn() → didClose(finally) lifecycle used by both
   *  query() and diagnostics() (previously inlined in doQuery). */
  private async withOpenDocument<T>(uri: string, filePath: string, source: string, fn: () => Promise<T>): Promise<T> {
    await this.conn.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.languageId(filePath), version: 1, text: source } })
    try {
      return await fn()
    } finally {
      await this.conn.notify("textDocument/didClose", { textDocument: { uri } })
    }
  }

  private async doQuery(query: LspQuery, source: string, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new Error("LSP instance was disposed")
    const capKey = OP_TO_CAPABILITY[query.operation]
    if (this.capabilities[capKey] === false || this.capabilities[capKey] === undefined) {
      throw new Error(`LSP_UNSUPPORTED_OPERATION: server does not support ${query.operation}`)
    }
    const uri = this.fileUri(query.filePath)
    return this.withOpenDocument(uri, query.filePath, source, async () => {
      const method = OP_TO_METHOD[query.operation]
      const params = {
        textDocument: { uri },
        position: { line: query.line - 1, character: query.character - 1 }, // 1-based → 0-based wire
        ...(query.operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
      }
      const result = await this.conn.request(method, params, signal)
      if (query.operation === "hover") {
        if (result === null) return { kind: "hover", hover: null }
        const h = result as { contents: unknown; range?: LspRange }
        const contents = typeof h.contents === "string" ? h.contents : JSON.stringify(h.contents)
        return { kind: "hover", hover: { contents, ...(h.range !== undefined ? { range: h.range } : {}) } }
      }
      const locations = (result as { locations?: unknown[] } | LspLocation[] | null) ?? []
      const locs = Array.isArray(locations) ? locations : (locations as { locations: LspLocation[] }).locations
      return locs.length === 0 ? { kind: "empty" } : { kind: "locations", locations: locs }
    })
  }

  private fileUri(filePath: string): string {
    return `file://${filePath.replace(/\\/g, "/")}`
  }

  private languageId(filePath: string): string {
    const ext = filePath.split(".").pop() ?? ""
    return ext
  }

  /** Bounded teardown (spec §3.4): shutdown request (best-effort, bound by
   *  shutdownTimeoutMs) → exit notify → grace (killGraceMs waiting for the process
   *  to close) → kill escalation. Settles after the bounded attempt; never awaits
   *  a dead process forever. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      const shutdown = this.conn.request("shutdown", null)
      // The shutdown request's own bound: timeout → treat as "shutdown failed, proceed anyway".
      // The rejection handler also keeps a late failure (e.g. the process closing after the
      // race settled) from surfacing as an unhandled rejection.
      const outcome = await Promise.race([
        shutdown.then(() => undefined, () => new Error("shutdown failed")),
        sleep(this.shutdownTimeoutMs).then(() => new Error("shutdown timed out")),
      ])
      if (outcome instanceof Error) throw outcome
    } catch {
      /* shutdown best-effort */
    }
    try {
      await this.conn.notify("exit", null)
    } catch {
      /* exit best-effort */
    }
    // Grace period: wait for the process to close; kill when it does not.
    const closed = await Promise.race([this.conn.closed.then(() => true), sleep(this.killGraceMs).then(() => false)])
    if (!closed) this.conn.kill()
  }
}
