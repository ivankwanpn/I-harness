import type { SessionView as Session, SessionEvent, SessionHeader } from "@i-harness/core-session"
import type { SettingsProviderProtocol } from "@i-harness/settings"

export interface SessionMeta extends SessionHeader {
  formatVersion: number
  sessionId: string
  createdAt: string
  /** C5 workspace grouping (DSH parity): the workspace registry record id,
   * recorded at create. Metadata, never a SessionEvent — lives in the header
   * (jsonl passthrough) and the workspace registry document. */
  workspaceId?: string
  /** C5 session title (DSH parity): header-rewrite metadata like rename —
   * never a SessionEvent (a rename is a metadata rewrite, not a log op). */
  title?: string
  /** Reversible navigation state; archiving never removes session events. */
  archived?: boolean
  /** C5 per-session model selection: header metadata (resolution chain:
   * session meta > llm.defaultModel > legacy core.model > unconfigured). */
  modelSelection?: SessionModelSelection
}

/** C5: one per-session model selection. */
export interface SessionModelSelection {
  /** Provider route ("deepseek" | "anthropic" | a custom route). */
  provider: string
  /** Model id within the provider's registry/catalog. */
  model: string
  /** The wire this session's selection was made on, when it named one.
   * ABSENT is not "the default" — it hands the decision to the chain
   * (model row > route > refusal). Design: protocol-selection §2, §4.2. */
  protocol?: SettingsProviderProtocol
  /** Optional reasoning-effort hint (forward-compatible passthrough). */
  reasoningEffort?: string
}

// One-directional seam (M4): the coordinator owns the backend interface; a
// concrete backend (e.g. JSONL now, SQLite later) implements it. Capabilities
// declare what consumers may rely on (F01-5).
export interface PersistenceBackend {
  readJournalPrefix?: import('./fact-types.ts').OwnedFactBackend['readJournalPrefix']
  appendOwnedBatch?: import('./fact-types.ts').OwnedFactBackend['appendOwnedBatch']
  reconcileOwnedBatch?: import('./fact-types.ts').OwnedFactBackend['reconcileOwnedBatch']
  id: "jsonl" | "sqlite"
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  /** Atomically replace the event body while preserving session metadata.
   * Optional because read-only/custom backends may not support writable crash
   * recovery; loadOwned fails closed when a rewrite is required. */
  replaceEvents?(sessionId: string, events: SessionEvent[]): Promise<void>
  /** Durable header barrier preserving raw body and metadata; called directly under the operation gate. */
  upgradeSessionFormat?(sessionId: string, expected: number, target: number): Promise<SessionMeta>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  // Generic non-session document store (M6): arbitrary keyed state such as
  // the subagent registry snapshot. Session-event semantics unchanged.
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  /**
   * Optional (M23): where this store's lock files live — jsonl returns its
   * root, sqlite the db's directory. The coordinator's ownership lease uses
   * it as the default lock root when `lock.lockRoot` is not given.
   */
  lockRoot?: string
  /** C5: cheap per-session meta profile (header read only on jsonl; no event
   * decode). `blank` = the log has no turn/start yet. Throws for an unknown
   * session — the caller surfaces it (never a silent default row). */
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean; updatedAt?: number }>
  /** C5: rewrite the durable session meta (merge patch atomically — jsonl:
   * header line replaced via temp+rename, event lines byte-exact; sqlite:
   * whitelisted-column UPDATE). Throws for an unknown session. */
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
  /** Exact store-owned artifacts; unsupported/custom stores withhold this capability. */
  deleteOwnedSession?(sessionId: string, manifest: SessionArtifactManifest): Promise<void>
  /** Read a durable closure's original visibility and exact cleanup manifest. */
  deletionReceipt?(sessionId: string): Promise<{ visibility: { origin?: string; parentSession?: string }; manifest: SessionArtifactManifest } | undefined>
}

export interface SessionArtifactManifest { documents: string[]; files?: string[] }

export interface CoordinatorOptions {
  maxPendingGroups?: number
  coalesceTargetBytes?: number
  /** Write-behind batching window. Default 200. */
  maxDelayMs?: number
  /** Observe a detached background document/write-behind failure. Default console.warn. */
  reportBackgroundFailure?: (error: unknown) => void
  /**
   * Ownership lease (M23), backed by @i-harness/fs-lock process-level locks.
   * `enabled` defaults to FALSE — opt-in (ruling M23-P2); the CLI wiring turns
   * it on. `lockRoot` defaults to the backend's `lockRoot` (jsonl: store root;
   * sqlite: the db's directory) or process.cwd().
   */
  lock?: { enabled?: boolean; lockRoot?: string }
  /** Passed through to acquireSessionLock: initial backoff between acquire attempts. */
  acquireRetryMs?: number
  /** Passed through to acquireSessionLock: total budget before declaring a conflict. */
  acquireDeadlineMs?: number
}

export interface SessionCoordinator {
  openManagedDocument(sessionId: string): Promise<import('./fact-types.ts').ManagedDocument>
  revokeManagedDocumentNewWork(sessionId: string): void
  closeManagedDocument(sessionId: string): Promise<void>
  ensureWritableFormat?(sessionId: string): Promise<{ formatVersion: number }>
  /** Drain producers before calling. Holds write ownership until the store commits its tombstone. */
  deleteOwnedSession?(sessionId: string, manifest: SessionArtifactManifest): Promise<void>
  deletionReceipt?(sessionId: string): Promise<{ visibility: { origin?: string; parentSession?: string }; manifest: SessionArtifactManifest } | undefined>
  create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  load(sessionId: string): Promise<{ session: Session }>
  /** Read the durable prefix without ownership, disk repair or runtime creation. */
  snapshot?(sessionId: string): Promise<{ session: Session }>
  /** Acquire long-term ownership before reading, durably canonicalize crash
   * recovery, and return a writable snapshot whose length equals its next seq. */
  loadOwned(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  /** C5: cheap per-session meta profile (header read only; no event decode).
   * Read-only — never acquires the ownership lease. */
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean; updatedAt?: number }>
  /** C5: merge a meta patch durably. MUTATING — runs under the ownership
   * lease (M23 discipline, same as append); a conflicting writer fails closed. */
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
  flush(sessionId: string): Promise<void>
  /**
   * Drain all live write-behinds best-effort (flush failures are aggregated) and
   * stop their automatic timers. Write-behinds stay in the map after close(),
   * so a later enqueue still works; a session whose flush failed here retains
   * its batch for a future enqueue/flush. When the ownership lease is enabled,
   * every held lease is released after the drain (M23).
   */
  close(): Promise<void>
  putDocument(key: string, data: unknown): Promise<void>
  /** Reject this document write's failure; subsequent document writes still proceed. */
  putDocumentStrict?(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  /** Whether this coordinator holds the session's write ownership lease (M23, opt-in lock). */
  ownerOf(sessionId: string): boolean
  /**
   * Acquire the session's ownership lease and hold it until close() — the CLI
   * resume path calls this after a successful load(). Throws
   * SessionLockConflictError when another live writer owns the session
   * (fail-closed); throws SessionLockUnsupportedError off-Windows in M23.
   */
  adoptOwnership(sessionId: string): Promise<void>
  /** Release one held ownership lease without closing the coordinator. Any
   * in-flight acquire for the same session settles before release. */
  releaseOwnership(sessionId: string): Promise<void>
}
