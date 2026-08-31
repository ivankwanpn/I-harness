/**
 * Message feedback store (task 4.3 — DSH message-feedback parity, simplified to
 * our stack's idioms).
 *
 * Storage: one opaque coordinator document per session, keyed
 * `feedback-<sessionId>` (the workspace-registry precedent — putDocument/
 * getDocument, a `<key>.doc.jsonl` sidecar on the jsonl backend). There is NO
 * dedicated package: the doc path is exactly the coordinator's generic
 * document store, and the only consumer of feedback persistence is the SPA
 * over the web host's HTTP routes — there is no embedder seam to compose.
 *
 * Wire semantics (aligned with DSH packages/feedback/message-feedback):
 *   - rating = "like" | "dislike"; note is OPTIONAL and persisted when
 *     present (whole-value replace semantics: a put carries the target value,
 *     so an absent note erases a stored note — DSH parity).
 *   - messageId = the event seq (decimal string) of the `assistant/message`
 *     event — the same identity EventRow.vue already passes to
 *     MessageFeedback as message-id. A put only targets a real finalized
 *     assistant message (DSH `target-not-found`; here
 *     message-not-found / HTTP 400).
 *   - CAS: PER-ITEM integer version (starts at 1, +1 per successful put). A
 *     put WITHOUT `ifVersion` overwrites unconditionally (force — the one
 *     deliberate extension vs DSH, which always requires the exact version);
 *     with `ifVersion` a mismatch is a version-conflict (HTTP 409, carries
 *     `current` so the client can reconcile, DSH version-conflict parity).
 *     An identical-value put is a no-op: the stored item returns unchanged,
 *     its version does not bump (DSH parity).
 *   - delete: removal of an item by messageId; absence succeeds regardless of
 *     the supplied version (DSH parity — `{ absent: true }`), an existing
 *     item requires the exact version when one is supplied.
 *   - The persisted item is { messageId, rating, note?, version, updatedAt }
 *     (simplified: no createdAt — the task ruling's shape).
 *
 * Concurrency: read-modify-write cycles on the per-session doc are serialized
 * on one promise chain (the workspace-registry pattern — two feedback PUTs
 * must never interleave and lose one's write).
 *
 * Durability failure (fix round 1 — reviewer Important #1): coordinator
 * putDocument's M6 contract is REPORT-NEVER-REJECT (`p.catch(report)` — a
 * failed backend write answers the caller with undefined and the vote would
 * silently vanish on refresh). Every write here therefore VERIFIES AFTER
 * WRITE — the doc is re-read and deep-compared with the intended snapshot; a
 * mismatch throws FeedbackPersistenceError, which the host surfaces as 500
 * (the 4.2 gate convention: durable failures are 5xx, never a silent 200).
 *
 * Errors carry DSH-style machine codes so the host maps them to HTTP statuses
 * without string matching: feedback-invalid (400), note-blank (400),
 * note-too-large (400), message-not-found (400), version-conflict (409).
 */

import { isDeepStrictEqual } from "node:util"
import type { Session } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"

/** The coordinator document key for one session's feedback (`feedback-<id>`). */
export const FEEDBACK_DOC_KEY_PREFIX = "feedback-"

/**
 * Max UTF-8 byte length accepted for one note (DSH's deployment maxNoteBytes
 * collapsed into one documented constant).
 */
export const MAX_FEEDBACK_NOTE_BYTES = 4096

export type MessageFeedbackRating = "like" | "dislike"

/** One persisted feedback item (the DSH MessageFeedbackItem surface, minus createdAt). */
export interface MessageFeedbackItem {
  /** Event seq string of the target `assistant/message` event (see module header). */
  messageId: string
  rating: MessageFeedbackRating
  /** Optional user note; absent when never provided or erased by a whole-value put. */
  note?: string
  /** Per-item CAS counter: 1 at first put, +1 per succeeding put. */
  version: number
  /** ISO-8601 instant of the last successful mutation. */
  updatedAt: string
}

/** Body of a feedback write (the wire request shape, exported for the SPA). */
export interface MessageFeedbackPutRequest {
  messageId: string
  rating: MessageFeedbackRating
  note?: string
  /**
   * Observed item version for the CAS check; OMIT to overwrite
   * unconditionally (force). Provided and mismatched → version-conflict.
   */
  ifVersion?: number
}

/** Durable snapshot shape stored under `feedback-<sessionId>` (subagent-snapshot pattern). */
export interface MessageFeedbackSnapshot {
  formatVersion: 1
  items: MessageFeedbackItem[]
}

/** The request payload violates a semantic input constraint (DSH: bad-request). */
export class FeedbackBadRequestError extends Error {
  readonly code = "feedback-invalid" as const
  constructor(message: string) {
    super(message)
    this.name = "FeedbackBadRequestError"
  }
}

/** An optional note was provided but is blank after trimming (DSH note-blank). */
export class FeedbackNoteEmptyError extends Error {
  readonly code = "note-blank" as const
  constructor() {
    super("备注不能为空")
    this.name = "FeedbackNoteEmptyError"
  }
}

/** An optional note exceeds the byte bound (DSH note-too-large). */
export class FeedbackNoteTooLargeError extends Error {
  readonly code = "note-too-large" as const
  constructor(readonly maxBytes: number, readonly actualBytes: number) {
    super(`备注过大：${actualBytes} 字节（上限 ${maxBytes} 字节）`)
    this.name = "FeedbackNoteTooLargeError"
  }
}

/** messageId does not name a finalized `assistant/message` event (DSH target-not-found). */
export class FeedbackMessageNotFoundError extends Error {
  readonly code = "message-not-found" as const
  constructor(message: string, readonly sessionId: string, readonly messageId: string) {
    super(message)
    this.name = "FeedbackMessageNotFoundError"
  }
}

/** ifVersion does not match the stored item's current version (DSH version-conflict). */
export class FeedbackVersionConflictError extends Error {
  readonly code = "version-conflict" as const
  /** The authoritative item the caller needs to reconcile; null = the target item is absent. */
  constructor(message: string, readonly current: MessageFeedbackItem | null) {
    super(message)
    this.name = "FeedbackVersionConflictError"
  }
}

/**
 * The doc write did not land (verify-after-write failed). The host surfaces it
 * as 500 — never a silent 200 with the vote gone on refresh.
 */
export class FeedbackPersistenceError extends Error {
  readonly code = "feedback-persist-failed" as const
  constructor(message: string) {
    super(message)
    this.name = "FeedbackPersistenceError"
  }
}

export interface MessageFeedbackStore {
  /** All feedback items for one session (insertion order). */
  list(sessionId: string): Promise<{ items: MessageFeedbackItem[] }>
  /** Upsert one item; resolves with the committed item (no-op keeps its version). */
  put(sessionId: string, request: MessageFeedbackPutRequest): Promise<{ item: MessageFeedbackItem }>
  /** Remove one item; absence is success (`{ absent: true }`). */
  delete(sessionId: string, messageId: string, ifVersion?: number): Promise<{ absent: true }>
}

const docKeyFor = (sessionId: string): string => `${FEEDBACK_DOC_KEY_PREFIX}${sessionId}`

function resolveRating(raw: unknown): MessageFeedbackRating {
  if (raw !== "like" && raw !== "dislike") {
    throw new FeedbackBadRequestError("rating 必须是 like 或 dislike")
  }
  return raw
}

function resolveNote(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") throw new FeedbackBadRequestError("note 必须是字符串")
  if (raw.trim().length === 0) throw new FeedbackNoteEmptyError()
  const actualBytes = Buffer.byteLength(raw, "utf8")
  if (actualBytes > MAX_FEEDBACK_NOTE_BYTES) throw new FeedbackNoteTooLargeError(MAX_FEEDBACK_NOTE_BYTES, actualBytes)
  return raw
}

function resolveIfVersion(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new FeedbackBadRequestError("ifVersion 必须是非负整数")
  }
  return raw
}

function resolveMessageId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim() !== raw) {
    throw new FeedbackBadRequestError("messageId 必须是字符串（assistant 消息的事件序号）")
  }
  const seq = Number(raw)
  if (!Number.isInteger(seq) || seq < 0) {
    throw new FeedbackBadRequestError("messageId 必须是非负整数序号（assistant 消息的事件序号）")
  }
  return raw
}

/** Whether the session log contains a finalized assistant message at the given seq. */
function hasAssistantMessageAt(session: Session, messageId: string): boolean {
  const seq = Number(messageId)
  return session.events.some((event, index) => (event.seq ?? index) === seq && event.type === "assistant/message")
}

/**
 * Registry over the coordinator document store (the createWorkspaceRegistry
 * shape). Mutations are serialized on one promise chain for the whole store:
 * two concurrent read-modify-write cycles on the shared doc must never
 * interleave and lose one's write. Reads join the chain too, so a list during
 * a mutation observes either the pre- or post-state, never a torn one.
 */
export function createMessageFeedbackStore(coordinator: SessionCoordinator): MessageFeedbackStore {
  let chain: Promise<void> = Promise.resolve()
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op)
    chain = run.then(() => {}, () => {}) // keep the tail alive after failures
    return run
  }

  async function loadSnapshot(key: string): Promise<MessageFeedbackSnapshot> {
    const doc = await coordinator.getDocument(key)
    if (doc === undefined) return { formatVersion: 1, items: [] }
    if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { items?: unknown }).items)) {
      throw new Error(`feedback doc is corrupt: ${key}`)
    }
    return doc as MessageFeedbackSnapshot
  }

  /**
   * Write + verify-after-write (fix round 1 — reviewer Important #1).
   * coordinator.putDocument NEVER rejects (M6: report-and-swallow), so a disk
   * failure would otherwise answer 200 with the vote gone on refresh. The
   * re-read runs inside the SAME serialized op, so a mismatch means the write
   * truly did not land — fail the request loudly instead.
   */
  async function writeSnapshot(key: string, snapshot: MessageFeedbackSnapshot): Promise<void> {
    await coordinator.putDocument(key, snapshot)
    const verified = await coordinator.getDocument(key)
    if (verified === undefined || !isDeepStrictEqual(verified, snapshot)) {
      throw new FeedbackPersistenceError(`反馈写入校验失败：${key}`)
    }
  }

  /**
   * Durable session + target-check authority. The write-behind is flushed
   * FIRST: a feedback click lands within the ≤200 ms batching window after the
   * message renders, so the live instance may hold the event the durable log
   * has not written yet — flushing before the check keeps that window honest.
   */
  async function targetSession(sessionId: string): Promise<Session> {
    await coordinator.flush(sessionId)
    return (await coordinator.load(sessionId)).session
  }

  return {
    list(sessionId) {
      return serialize(async () => {
        await coordinator.load(sessionId) // unknown session → backend error → host 404
        const snap = await loadSnapshot(docKeyFor(sessionId))
        return { items: snap.items }
      })
    },
    put(sessionId, request) {
      return serialize(async () => {
        // Cheap-field validation BEFORE any load: a malformed request answers
        // 400 even for a session the runtime does not know.
        const rating = resolveRating(request.rating)
        const note = resolveNote(request.note)
        const ifVersion = resolveIfVersion(request.ifVersion)
        const messageId = resolveMessageId(request.messageId)
        const session = await targetSession(sessionId) // unknown session → 404 by the host
        if (!hasAssistantMessageAt(session, messageId)) {
          throw new FeedbackMessageNotFoundError(
            `会话 "${sessionId}" 的序号 ${messageId} 不是 assistant 消息，无法对该消息反馈`,
            sessionId,
            messageId,
          )
        }
        const key = docKeyFor(sessionId)
        const snap = await loadSnapshot(key)
        const index = snap.items.findIndex(item => item.messageId === messageId)
        const existing = index === -1 ? undefined : snap.items[index]
        if (ifVersion !== undefined && ifVersion !== (existing?.version ?? null)) {
          throw new FeedbackVersionConflictError(
            "反馈状态版本冲突：请刷新后重试",
            existing ?? null,
          )
        }
        // DSH parity: an identical-value put is a no-op — the stored item is
        // returned unchanged, its version does not bump.
        if (existing !== undefined && existing.rating === rating && existing.note === note) {
          return { item: existing }
        }
        const now = new Date().toISOString()
        const item: MessageFeedbackItem = {
          messageId,
          rating,
          ...(note === undefined ? {} : { note }),
          version: (existing?.version ?? 0) + 1,
          updatedAt: now,
        }
        const items = [...snap.items]
        if (index === -1) items.push(item)
        else items[index] = item
        await writeSnapshot(key, { formatVersion: 1, items })
        return { item }
      })
    },
    delete(sessionId, messageId, ifVersion) {
      return serialize(async () => {
        const resolved = resolveMessageId(messageId)
        const resolvedIf = resolveIfVersion(ifVersion)
        await coordinator.load(sessionId) // unknown session → backend error → host 404
        const key = docKeyFor(sessionId)
        const snap = await loadSnapshot(key)
        const existing = snap.items.find(item => item.messageId === resolved)
        // DSH parity: deleting an absent item succeeds regardless of version.
        if (existing === undefined) return { absent: true }
        if (resolvedIf !== undefined && resolvedIf !== existing.version) {
          throw new FeedbackVersionConflictError("反馈状态版本冲突：请刷新后重试", existing)
        }
        const items = snap.items.filter(item => item.messageId !== resolved)
        await writeSnapshot(key, { formatVersion: 1, items })
        return { absent: true }
      })
    },
  }
}
