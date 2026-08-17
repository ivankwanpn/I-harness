import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from "@i-harness/core-session"

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
}

export interface SessionCoordinator {
  create(): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  flush(sessionId: string): Promise<void>
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

export function createSessionCoordinator(backend: PersistenceBackend): SessionCoordinator {
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
    async flush(_sessionId) {
      // append batches already fsync at the backend; flush is the explicit
      // durability barrier (a no-op today, kept on the seam for callers that
      // want to be explicit about ordering).
    },
  }
}
