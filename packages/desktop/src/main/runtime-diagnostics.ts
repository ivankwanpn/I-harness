import { randomUUID } from "node:crypto"
import { mkdir, lstat, open, rename, unlink, appendFile, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createRedactor } from "../../../diagnostics/src/redactor.ts"
import type { ModelRetryInfo, ModelActivityInfo } from "../../../core-session/src/index.ts"
import type { DesktopEvent } from "../shared/bridge.ts"
import type { RuntimeActivity, RuntimeDiagnosticEntry, RuntimeDiagnosticFilter, RuntimeDiagnosticKind, RuntimeDiagnosticList } from "../shared/runtime-diagnostics.ts"

const FILE_BYTES = 5 * 1024 * 1024
const EXPORT_BYTES = 20 * 1024 * 1024
const RETENTION = 7 * 86400000
const VIEW_LIMIT = 1000
const storageFailure = "Diagnostic log storage is unavailable. Live diagnostics remain available."
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === "string" && (value === "[REDACTED]" || /^[a-zA-Z0-9._:/-]{1,128}$/.test(value))
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
const kinds: RuntimeDiagnosticKind[] = ["model/retry", "model/recovered", "model/connecting", "model/quiet", "model/settled", "session/error", "session/cancelled", "gateway/disconnected", "runtime/error"]
const codes = new Set(["http_400", "http_401", "http_402", "http_403", "http_408", "http_413", "http_429", "http_500", "http_502", "http_503", "http_504", "network", "timeout", "authentication", "quota", "context_limit", "invalid_arguments", "cancelled", "model_error", "gateway_disconnected", "runtime_error", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"])
for (const code of ["UNKNOWN", "ABORTED", "AUTH", "INVALID_API_KEY", "QUOTA", "CONTEXT_WINDOW_EXCEEDED", "INVALID_ARGUMENT", "MALFORMED_RESPONSE", "TLS", "RATE_LIMIT", "TIMEOUT", "TRANSPORT", "SERVER", "CAPACITY"]) codes.add(code)

export interface RuntimeDiagnosticNativeOptions {
  copy?(text: string): void | Promise<void>
  pickExport?(): Promise<string | undefined>
  reveal?(directory: string): Promise<void>
}

/** One app-owned observer, independent of window creation/destruction. Callbacks
 * run before disk writes and are isolated from runtime execution. */
export function createRuntimeDiagnostics(directory: string, options: RuntimeDiagnosticNativeOptions = {}) {
  const redactor = createRedactor()
  const listeners = new Set<(entry: RuntimeDiagnosticEntry) => void>()
  const activityListeners = new Set<(activity: RuntimeActivity) => void>()
  const activeAttempts = new Map<string, string>()
  const closedAttempts = new Set<string>()
  const executionStates = new Map<string, { revision: number; busy: boolean }>()
  const memory: RuntimeDiagnosticEntry[] = []
  const seen = new Set<string>()
  const startupFailures = new WeakMap<object, string>()
  const scopes = new Map<string, { turn: string; lastStart?: number; status?: string; requestId?: string }>()
  let pending = Promise.resolve()
  let storageError: string | undefined
  let nextMaintenance = 0
  const files = [0, 1, 2].map(i => join(directory, `runtime-diagnostics.${i}.jsonl`))
  const safeId = (value: unknown) => identifier(value) ? String(redactor.redact(value)) : undefined
  const executionBusy = (workspaceId: string, sessionId?: string) => executionStates.get(JSON.stringify([workspaceId, sessionId]))?.busy === true
  function closeAttempt(key: string) {
    const requestId = activeAttempts.get(key)
    if (!requestId) return
    activeAttempts.delete(key)
    closedAttempts.add(JSON.stringify([key, requestId]))
    if (closedAttempts.size > 4000) closedAttempts.delete(closedAttempts.values().next().value!)
  }
  function scope(workspaceId: string, sessionId?: string) {
    const key = JSON.stringify([workspaceId, sessionId])
    let value = scopes.get(key)
    if (!value) { value = { turn: randomUUID() }; scopes.set(key, value) }
    // Bound long-lived app state independently of persisted history.
    if (scopes.size > 2000) scopes.delete(scopes.keys().next().value!)
    return value
  }
  function safeRetry(value: unknown): ModelRetryInfo | undefined {
    if (!record(value) || !identifier(value.requestId) || !["waiting", "attempting", "recovered"].includes(String(value.phase)) || !integer(value.attempt, 1, Number.MAX_SAFE_INTEGER) || !integer(value.delayMs, 0, 60000)) return
    if (value.maxRetries !== undefined && !integer(value.maxRetries, 0, Number.MAX_SAFE_INTEGER)) return
    return { requestId: safeId(value.requestId)!, phase: value.phase as ModelRetryInfo["phase"], attempt: value.attempt, delayMs: value.delayMs,
      code: typeof value.code === "string" && codes.has(value.code) ? value.code : "model_error",
      ...(value.maxRetries === undefined ? {} : { maxRetries: value.maxRetries as number }),
      ...(integer(value.nextAttemptAt, 0, Number.MAX_SAFE_INTEGER) ? { nextAttemptAt: value.nextAttemptAt } : {}),
      ...(integer(value.httpStatus, 100, 599) ? { httpStatus: value.httpStatus } : {}),
      ...(safeId(value.providerId) ? { providerId: safeId(value.providerId) } : {}),
      ...(safeId(value.modelId) ? { modelId: safeId(value.modelId) } : {}),
      ...(value.discardOutput === true ? { discardOutput: true as const } : {}),
    }
  }
  function safeActivity(value: unknown): ModelActivityInfo | undefined {
    if (!record(value) || !identifier(value.requestId) || !["connecting", "streaming", "quiet", "settled"].includes(String(value.phase))
      || !integer(value.startedAt, 0, Number.MAX_SAFE_INTEGER) || !["first-response", "progress"].includes(String(value.waitingFor))) return
    if (value.lastProgressAt !== undefined && (!integer(value.lastProgressAt, value.startedAt, Number.MAX_SAFE_INTEGER))) return
    if (value.outcome !== undefined && !["completed", "failed", "cancelled"].includes(String(value.outcome))) return
    return { requestId: safeId(value.requestId)!, phase: value.phase as ModelActivityInfo["phase"], startedAt: value.startedAt,
      waitingFor: value.waitingFor as ModelActivityInfo["waitingFor"],
      ...(value.lastProgressAt === undefined ? {} : { lastProgressAt: value.lastProgressAt as number }),
      ...(value.outcome === undefined ? {} : { outcome: value.outcome as ModelActivityInfo["outcome"] }) }
  }
  function sanitize(value: unknown): RuntimeDiagnosticEntry | undefined {
    if (!record(value) || !identifier(value.id) || !integer(value.timestamp, 0, Number.MAX_SAFE_INTEGER) || !kinds.includes(value.kind as RuntimeDiagnosticKind)) return
    const kind = value.kind as RuntimeDiagnosticKind
    const retry = safeRetry(value.retry)
    const httpStatus = integer(value.httpStatus, 100, 599) ? value.httpStatus : undefined
    const code = typeof value.code === "string" && codes.has(value.code) ? value.code : undefined
    const waitingFor = kind.startsWith("model/") && ["first-response", "progress"].includes(String(value.waitingFor)) ? value.waitingFor as ModelActivityInfo["waitingFor"] : undefined
    const outcome = kind === "model/settled" && ["completed", "failed", "cancelled"].includes(String(value.outcome)) ? value.outcome as ModelActivityInfo["outcome"] : undefined
    const message = kind === "model/retry" ? `${retry?.code === "CAPACITY" ? "Model temporarily at capacity. " : ""}Model connection retry ${retry?.attempt ?? 1} (${retry?.phase ?? "waiting"}).`
      : kind === "model/recovered" ? "Model connection recovered."
      : kind === "model/connecting" ? "Model request started."
      : kind === "model/quiet" ? "Model request is waiting for a response or progress."
      : kind === "model/settled" ? "Model request attempt settled."
      : kind === "session/cancelled" ? "User work cancelled."
      : kind === "gateway/disconnected" ? "Local gateway disconnected. Reconnect to continue."
      : kind === "runtime/error" ? "Runtime request could not start."
      : `${code === "CAPACITY" ? "Model temporarily at capacity. " : ""}Model request failed${httpStatus ? ` (HTTP ${httpStatus})` : code ? ` (${code})` : ""}.`
    return { id: safeId(value.id)!, timestamp: value.timestamp, kind, level: kind === "model/retry" ? "warning" : kind === "session/cancelled" || kind === "model/recovered" || kind.startsWith("model/") ? "info" : "error", message,
      ...(safeId(value.workspaceId) ? { workspaceId: safeId(value.workspaceId) } : {}), ...(safeId(value.sessionId) ? { sessionId: safeId(value.sessionId) } : {}),
      ...(safeId(value.requestId) ? { requestId: safeId(value.requestId) } : {}), ...(code ? { code } : {}), ...(httpStatus ? { httpStatus } : {}), ...(retry ? { retry } : {}),
      ...((kind === "session/error" || kind === "session/cancelled") && value.executionUncorrelated === true ? { executionUncorrelated: true as const } : {}),
      ...(waitingFor ? { waitingFor } : {}), ...(outcome ? { outcome } : {}) }
  }
  async function statOwned(path: string) {
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe diagnostic file"); return stat }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  }
  async function prune() {
    await mkdir(directory, { recursive: true })
    for (const path of files) { const stat = await statOwned(path); if (stat && stat.mtimeMs < Date.now() - RETENTION) await unlink(path) }
    if (Date.now() < nextMaintenance) return
    let earliestExpiry = Date.now() + RETENTION
    for (const path of files) {
      const stat = await statOwned(path); if (!stat) continue
      // Only the three owned files, with a hard byte/record bound. Remove
      // malformed/expired data during startup maintenance, before any append.
      if (stat.size > FILE_BYTES) { await unlink(path); continue }
      const text = await readFile(path, "utf8")
      const entries: RuntimeDiagnosticEntry[] = []
      for (const line of text.split("\n").reverse().filter(Boolean).slice(0, VIEW_LIMIT)) {
        if (line.length > 16384) continue
        try { const entry = sanitize(JSON.parse(line)); if (entry && entry.timestamp >= Date.now() - RETENTION) { entries.push(entry); earliestExpiry = Math.min(earliestExpiry, entry.timestamp + RETENTION + 1) } } catch { /* Invalid record. */ }
      }
      const safe = entries.reverse().map(entry => JSON.stringify(entry) + "\n").join("")
      if (safe !== text) await writeFile(path, safe, { mode: 0o600 })
    }
    nextMaintenance = earliestExpiry
  }
  async function persist(entry: RuntimeDiagnosticEntry) {
    await prune()
    const line = JSON.stringify(entry) + "\n"
    const size = (await statOwned(files[0]!))?.size ?? 0
    if (size + Buffer.byteLength(line) > FILE_BYTES) {
      if (await statOwned(files[2]!)) await unlink(files[2]!)
      if (await statOwned(files[1]!)) await rename(files[1]!, files[2]!)
      if (await statOwned(files[0]!)) await rename(files[0]!, files[1]!)
    }
    await appendFile(files[0]!, line, { mode: 0o600 })
    nextMaintenance = Math.min(nextMaintenance, entry.timestamp + RETENTION + 1)
  }
  function add(value: Omit<RuntimeDiagnosticEntry, "id" | "timestamp" | "message" | "level">, key: string) {
    if (seen.has(key)) return
    seen.add(key); if (seen.size > 4000) seen.delete(seen.values().next().value!)
    const entry = sanitize({ ...value, id: randomUUID(), timestamp: Date.now() })!
    memory.unshift(entry); if (memory.length > VIEW_LIMIT) memory.pop()
    for (const listener of [...listeners]) { try { listener(structuredClone(entry)) } catch { /* UI errors cannot interrupt the model. */ } }
    pending = pending.then(() => persist(entry)).catch(() => { storageError = storageFailure })
  }
  function failure(workspaceId: string, sessionId: string | undefined, error: unknown, kind: "session/error" | "runtime/error" = "session/error", admissionId?: string) {
    // Rejected admission belongs to its RPC, independently of any running
    // turn. A queued submission must never replace the active model identity.
    // Legacy status/rejection notifications carry no execution identity. An
    // older workflow can finish recovery after another turn starts. Keep its
    // failure, but never borrow the busy execution's retry or terminal slot.
    const uncorrelated = admissionId === undefined && kind === "session/error" && executionBusy(workspaceId, sessionId)
    const state: ReturnType<typeof scope> = admissionId !== undefined ? { turn: admissionId, requestId: admissionId }
      : uncorrelated ? { turn: scope(workspaceId, sessionId).turn } : scope(workspaceId, sessionId)
    if (kind === "runtime/error" && sessionId === undefined) {
      if (error !== null && typeof error === "object") {
        let identity = startupFailures.get(error)
        if (!identity) { identity = randomUUID(); startupFailures.set(error, identity) }
        state.turn = identity
      } else state.turn = randomUUID()
    }
    // Only inspect facts; the original string never enters an entry.
    const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : ""
    const facts = error !== null && typeof error === "object" ? error as { code?: unknown; httpStatus?: unknown; name?: unknown } : {}
    // Owned agent cancellation is forwarded as the exact message by status,
    // and as Error/RpcError/SdkRunError by request/run rejection. Anchor the
    // entire phrase so an upstream response containing it remains a failure.
    // AbortSignal.throwIfAborted and node:timers/promises use these default
    // messages; the gateway sends only .message, losing their AbortError name.
    const agentAborted = /^(?:(?:Error|RpcError|SdkRunError):\s*)?(?:agent aborted|This operation was aborted|The operation was aborted)$/.test(text)
    const cancelled = agentAborted || /^(?:(?:Error|RpcError|SdkRunError):\s*)?Model request aborted$/.test(text) || facts.name === "AbortError" || facts.code === "ABORTED" || facts.code === "ABORT_ERR" || /^(?:Error:\s*)?(?:AbortError\b|aborted$|cancelled$|canceled$|operation (?:was )?aborted$|[a-zA-Z -]*request aborted by (?:the )?caller\b)/i.test(text)
    const status = integer(facts.httpStatus, 100, 599) ? facts.httpStatus : Number(/(?:\bHTTP\s+|\brequest failed:\s*)(\d{3})\b/i.exec(text)?.[1])
    // The Responses adapter prefixes its structured error code. SDK status
    // forwarding keeps that prefix but drops the separate code property.
    // Match only the leading identity or the exact known message-only form;
    // a capacity phrase embedded in another error must not change its reason.
    const streamMessage = text.replace(/^(?:Error|RpcError|SdkRunError):\s*/, "").replace(/^model stream error: /, "")
    const capacity = /\brequest failed:\s*\d{3} \(model is at capacity\)\s*$/.test(text)
      || /^(?:server_is_overloaded|server_overloaded): /.test(streamMessage)
      || /^Selected model is at capacity\.(?: Please try a different model\.)?$/.test(streamMessage)
    const ownedTimeout = /^(?:(?:Error|RpcError|SdkRunError):\s*)?Model request timed out waiting for (?:first response|progress)$/.test(text)
    const code = cancelled ? "cancelled" : typeof facts.code === "string" && codes.has(facts.code) ? facts.code : ownedTimeout ? "TIMEOUT" : capacity ? "CAPACITY" : integer(status, 100, 599) ? (codes.has(`http_${status}`) ? `http_${status}` : "model_error") : "model_error"
    add({ workspaceId, ...(sessionId ? { sessionId } : {}), ...(state.requestId ? { requestId: state.requestId } : {}), ...(uncorrelated ? { executionUncorrelated: true as const } : {}), kind: cancelled ? "session/cancelled" : kind, code, ...(integer(status, 100, 599) ? { httpStatus: status } : {}) }, JSON.stringify([workspaceId, sessionId, state.turn, admissionId !== undefined ? "admission" : uncorrelated ? "uncorrelated" : "terminal"]))
    state.status = cancelled ? "cancelled" : "failed"
    if (admissionId === undefined && !uncorrelated && sessionId && kind === "session/error") closeAttempt(JSON.stringify([workspaceId, sessionId]))
  }
  const service = {
    createAdmissionFailureRecorder(workspaceId: string, sessionId: string, clientToken?: string) {
      const identity = clientToken ?? randomUUID()
      return (error: unknown) => { failure(workspaceId, sessionId, error, "runtime/error", identity) }
    },
    beginRequest(workspaceId: string, sessionId: string, clientToken?: string) {
      const state = scope(workspaceId, sessionId)
      const identity = safeId(clientToken) ?? randomUUID()
      if (state.turn === identity) return
      state.turn = identity; state.requestId = identity; state.status = "running"
    },
    observe(event: DesktopEvent) {
      if (event.kind === "sdk/disconnected") {
        for (const key of activeAttempts.keys()) if (JSON.parse(key)[0] === event.workspaceId) closeAttempt(key)
        for (const key of executionStates.keys()) if (JSON.parse(key)[0] === event.workspaceId) executionStates.delete(key)
        const state = scope(event.workspaceId)
        add({ kind: "gateway/disconnected", workspaceId: event.workspaceId, code: "gateway_disconnected" }, JSON.stringify([event.workspaceId, state.turn, "disconnect"]))
        return
      }
      if (event.kind !== "sdk/notification" || !record(event.params) || !identifier(event.params.sessionId)) return
      const sessionId = event.params.sessionId
      const state = scope(event.workspaceId, sessionId)
      if (event.method === "session/event" && record(event.params.event)) {
        const item = event.params.event
        if (item.type === "turn/start") {
          if (integer(item.seq, 0, Number.MAX_SAFE_INTEGER) && state.lastStart === item.seq) return
          state.turn = randomUUID(); state.lastStart = integer(item.seq, 0, Number.MAX_SAFE_INTEGER) ? item.seq : undefined; state.requestId = undefined; state.status = "running"
          closeAttempt(JSON.stringify([event.workspaceId, sessionId]))
        } else if (item.type === "model/activity" && item.version === 1) {
          if (!identifier(event.workspaceId)) return
          const activity = safeActivity(item.activity); if (!activity) return
          const key = JSON.stringify([event.workspaceId, sessionId])
          const identity = JSON.stringify([key, activity.requestId])
          if (activity.phase === "connecting") {
            if (closedAttempts.has(identity)) return
            if (activeAttempts.get(key) && activeAttempts.get(key) !== activity.requestId) closeAttempt(key)
            activeAttempts.set(key, activity.requestId)
          } else if (activeAttempts.get(key) !== activity.requestId) return
          const safe = { workspaceId: safeId(event.workspaceId)!, sessionId: safeId(sessionId)!, activity }
          for (const listener of [...activityListeners]) { try { listener(structuredClone(safe)) } catch { /* UI errors cannot interrupt the model. */ } }
          if (activity.phase === "connecting" || activity.phase === "quiet" || activity.phase === "settled")
            add({ kind: `model/${activity.phase}` as RuntimeDiagnosticKind, workspaceId: event.workspaceId, sessionId, requestId: activity.requestId, waitingFor: activity.waitingFor, ...(activity.outcome ? { outcome: activity.outcome } : {}) }, JSON.stringify([key, activity.requestId, activity.phase]))
          if (activity.phase === "settled") {
            closeAttempt(key)
          }
        } else if (item.type === "model/retry" && item.version === 1) {
          const retry = safeRetry(item.retry); if (!retry) return
          if (retry.phase === "recovered" && state.requestId !== retry.requestId) return
          state.requestId = retry.requestId
          add({ kind: retry.phase === "recovered" ? "model/recovered" : "model/retry", workspaceId: event.workspaceId, sessionId, requestId: retry.requestId, retry, code: retry.code, ...(retry.httpStatus ? { httpStatus: retry.httpStatus } : {}) }, JSON.stringify([event.workspaceId, sessionId, retry.requestId, retry.phase, retry.attempt]))
        }
      } else if (event.method === "session/status") {
        const status = event.params.status
        if (status === "running" || status === "queued") {
          if (state.status && !["running", "queued"].includes(state.status)) { state.turn = randomUUID(); state.requestId = undefined }
          state.status = status
          const workspace = scope(event.workspaceId); workspace.turn = state.turn
        } else if (status === "failed" || status === "error") failure(event.workspaceId, sessionId, event.params.error)
        else if (status === "cancelled" || status === "canceled") failure(event.workspaceId, sessionId, "cancelled")
        else if (status === "completed" && !executionBusy(event.workspaceId, sessionId)) { state.status = status; closeAttempt(JSON.stringify([event.workspaceId, sessionId])) }
      } else if (event.method === "session/execution-state") {
        const key = JSON.stringify([event.workspaceId, sessionId])
        const revision = event.params.revision
        if (!integer(revision, 1, Number.MAX_SAFE_INTEGER) || revision <= (executionStates.get(key)?.revision ?? 0)
          || typeof event.params.running !== "boolean" || !integer(event.params.queued, 0, Number.MAX_SAFE_INTEGER)) return
        executionStates.set(key, { revision, busy: event.params.running || event.params.queued > 0 })
        if (executionStates.size > 2000) executionStates.delete(executionStates.keys().next().value!)
        if (event.params.running === false && event.params.queued === 0) closeAttempt(key)
      }
    },
    recordRequestFailure(workspaceId: string, sessionId: string | undefined, error: unknown, kind: "session/error" | "runtime/error" = "session/error") { failure(workspaceId, sessionId, error, kind) },
    onEntry(listener: (entry: RuntimeDiagnosticEntry) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    onActivity(listener: (activity: RuntimeActivity) => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener) } },
    async flush() { await pending },
    async list(filter: RuntimeDiagnosticFilter = {}): Promise<RuntimeDiagnosticList> {
      const reading = pending.then(async () => {
      const loaded: RuntimeDiagnosticEntry[] = []
      try {
        await prune()
        let readRecords = 0
        for (const path of files) {
          if (readRecords >= VIEW_LIMIT) break
          const stat = await statOwned(path); if (!stat) continue
          // Read from the tail in bounded chunks, never read a journal or an unbounded file.
          const handle = await open(path, "r")
          try {
            let offset = stat.size; const floor = Math.max(0, stat.size - FILE_BYTES); let tail = ""
            while (offset > floor && readRecords < VIEW_LIMIT) {
              const length = Math.min(65536, offset - floor); offset -= length
              const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, offset)
              const lines = (buffer.toString("utf8") + tail).split("\n"); tail = lines.shift() ?? ""
              for (const line of lines.reverse()) { if (!line) continue; if (++readRecords > VIEW_LIMIT) break; if (line.length > 16384) continue; try { const entry = sanitize(JSON.parse(line)); if (entry && entry.timestamp >= Date.now() - RETENTION) loaded.push(entry) } catch { /* Skip incomplete/malformed lines. */ } }
              if (tail.length > 16384) tail = ""
            }
            if (offset === 0 && tail && readRecords < VIEW_LIMIT && tail.length <= 16384) { try { const entry = sanitize(JSON.parse(tail)); if (entry && entry.timestamp >= Date.now() - RETENTION) loaded.push(entry) } catch { /* Invalid record. */ } }
          } finally { await handle.close() }
        }
      } catch { storageError = storageFailure }
      const unique = new Map<string, RuntimeDiagnosticEntry>()
      for (const entry of [...memory, ...loaded]) if (entry.timestamp >= Date.now() - RETENTION && !unique.has(entry.id)) unique.set(entry.id, entry)
      const entries = [...unique.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, VIEW_LIMIT).filter(entry =>
        (!filter.workspaceId || entry.workspaceId === filter.workspaceId) && (!filter.sessionId || entry.sessionId === filter.sessionId) && (!filter.level || entry.level === filter.level) &&
        (!filter.query || JSON.stringify(entry).toLowerCase().includes(filter.query.toLowerCase())))
      return { entries: structuredClone(entries), ...(storageError ? { storageError } : {}) }
      })
      pending = reading.then(() => {}, () => {})
      return reading
    },
    async copy(id: string) {
      const entry = (await service.list()).entries.find(row => row.id === id)
      if (!entry) throw new Error("Diagnostic entry unavailable")
      if (!options.copy) throw new Error("Diagnostic clipboard unavailable")
      await options.copy(JSON.stringify(entry, null, 2)); return { copied: true as const }
    },
    async export(filter: RuntimeDiagnosticFilter = {}) {
      const snapshot = await service.list(filter)
      const text = JSON.stringify({ version: 1, entries: snapshot.entries }, null, 2)
      if (Buffer.byteLength(text) > EXPORT_BYTES) throw new Error("Diagnostic export exceeds limit")
      if (!options.pickExport) throw new Error("Diagnostic save picker unavailable")
      const path = await options.pickExport()
      if (!path) return { exported: false, count: 0 }
      await writeFile(path, text, { mode: 0o600 }); return { exported: true, count: snapshot.entries.length }
    },
    async reveal() { if (!options.reveal) throw new Error("Diagnostic folder reveal unavailable"); await service.list(); await options.reveal(directory); return { revealed: true as const } },
  }
  return service
}
