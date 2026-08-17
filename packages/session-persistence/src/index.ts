import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"

export { SessionWriteBehind, type SessionWriteBehindOptions }

export interface SessionMeta {
  formatVersion: number
  sessionId: string
  createdAt: string
}

// One-directional seam (M4): the coordinator owns the backend interface; a
// concrete backend (e.g. JSONL now, SQLite later) implements it. Capabilities
// declare what consumers may rely on (F01-5).
export interface PersistenceBackend {
  id: "jsonl" | "sqlite"
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  // Generic non-session document store (M6): arbitrary keyed state such as
  // the subagent registry snapshot. Session-event semantics unchanged.
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}

export interface CoordinatorOptions {
  /** Write-behind batching window. Default 200. */
  maxDelayMs?: number
  /** Observe a detached background document/write-behind failure. Default console.warn. */
  reportBackgroundFailure?: (error: unknown) => void
}

export interface SessionCoordinator {
  create(): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  flush(sessionId: string): Promise<void>
  /**
   * Drain all live write-behinds best-effort (flush failures are swallowed) and
   * stop their automatic timers. Write-behinds stay in the map after close(),
   * so a later enqueue still works; a session whose flush failed here retains
   * its batch for a future enqueue/flush.
   */
  close(): Promise<void>
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}

// F01-7: refusal before structural decode — "upgrade the harness", never a
// silent corruption.
export class SessionFormatUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionFormatUnsupportedError"
  }
}

// F01-1: stepwise upgrade chain — v(N) → v(N+1). Today only v1 exists, so the
// chain is empty; the first format bump only needs registerUpgrade(1, fn).
const upgrades = new Map<number, (events: SessionEvent[]) => SessionEvent[]>()
export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void {
  upgrades.set(from, fn)
}

const KNOWN_EVENT_TYPES = new Set([
  "turn/start", "step/start", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end",
])

export function createSessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const writeBehinds = new Map<string, SessionWriteBehind>()
  let docChain: Promise<void> = Promise.resolve()

  const writeBehindFor = (sessionId: string): SessionWriteBehind => {
    let wb = writeBehinds.get(sessionId)
    if (!wb) {
      wb = new SessionWriteBehind({
        maxDelayMs,
        write: (events) => backend.append(sessionId, events),
        reportBackgroundFailure: report,
      })
      writeBehinds.set(sessionId, wb)
    }
    return wb
  }

  async function migrate(version: number, events: SessionEvent[]): Promise<SessionEvent[]> {
    let v = version
    let result = events
    while (v < CURRENT_FORMAT_VERSION) {
      const up = upgrades.get(v)
      if (!up) throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
      result = up(result)
      v += 1
    }
    if (v > CURRENT_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(`format version ${v} is newer than this build (upgrade the harness)`)
    }
    return result
  }

  // F01-7: refuse unsupported versions BEFORE the backend's repair can
  // structurally decode + rewrite a foreign-version file. Read is
  // non-destructive (torn-tail tolerant, never mutates); repair may truncate
  // + rewrite, so it is only reached once the version gate has passed.
  function assertVersionSupported(version: number): void {
    if (version > CURRENT_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(`format version ${version} is newer than this build (upgrade the harness)`)
    }
    let v = version
    while (v < CURRENT_FORMAT_VERSION) {
      if (!upgrades.has(v)) {
        throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
      }
      v += 1
    }
  }

  function guardIgnorable(events: SessionEvent[]): SessionEvent[] {
    const kept: SessionEvent[] = []
    for (const ev of events) {
      if (KNOWN_EVENT_TYPES.has(ev.type)) { kept.push(ev); continue }
      if ((ev as { ignorable?: true }).ignorable === true) continue // safely dropped
      throw new SessionFormatUnsupportedError(`unknown event type '${ev.type}' without ignorable marker`)
    }
    return kept
  }

  return {
    async create() {
      const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await backend.create(id, { formatVersion: CURRENT_FORMAT_VERSION, sessionId: id, createdAt: new Date().toISOString() })
      return { id }
    },
    async append(sessionId, events) {
      await backend.append(sessionId, events)
    },
    enqueue(sessionId, events) {
      const wb = writeBehindFor(sessionId)
      for (const ev of events) wb.enqueue(ev)
    },
    async load(sessionId) {
      // Version gate BEFORE any backend mutation: a future-format session must
      // be refused on a non-destructive read alone — repair may rewrite the
      // file, and it must never touch bytes the current build cannot decode.
      const peeked = await backend.read(sessionId)
      assertVersionSupported(peeked.version)
      const { version, events } = await backend.repair(sessionId)
      const guarded = guardIgnorable(events)
      const migrated = await migrate(version, guarded)
      return { session: { formatVersion: CURRENT_FORMAT_VERSION, events: migrated } }
    },
    async list() {
      return backend.list()
    },
    async flush(sessionId) {
      const wb = writeBehinds.get(sessionId)
      if (wb) await wb.flush()
    },
    async close() {
      await Promise.allSettled([...writeBehinds.values()].map((wb) => wb.flush()))
      for (const wb of writeBehinds.values()) wb.cancelAutomaticWait()
      await docChain
    },
    async putDocument(key, data) {
      const p = docChain.then(() => backend.putDocument(key, data))
      docChain = p.catch(() => {}) // keep the chain alive after a failure
      return p.catch((error: unknown) => { report(error) }) // report; never rejects the caller
    },
    async getDocument(key) {
      return backend.getDocument(key)
    },
  }
}
