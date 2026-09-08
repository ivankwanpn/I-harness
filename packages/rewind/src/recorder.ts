// packages/rewind/src/recorder.ts — RewindRecorder: the in-process capture
// gluing the fs write pipeline to the journal. The assembly wires a
// subscription: `user/message` → begin(anchorSeq, text); fs write tools call
// take(path, beforeBytes) synchronously (they hold the pre-image bytes from
// their read-modify-write path); `turn/end` → finalize() re-reads the touched
// set (cheap), persists blobs and returns the RewindPoint for the caller to
// store.
//
// take-once: per (turn, path), the FIRST pre-image wins (or_insert) — a
// second write to the same file in the same turn captures the file's
// intermediate state, not its pre-turn state, so it is discarded. The blob id
// returned to the tool (for the result's preImageRef) is the turn's restore
// source, not this write's.
//
// M54 G2 durability: take() is synchronous, so the durable side is a serial
// queue — each take enqueues `writeBlob(pre-image)` then `writePending(sidecar)`
// (blob first: the sidecar must never reference a missing pre-image). Each op
// snapshots the entry list EAGERLY, before it is queued: a lazy snapshot would
// let an early op's sidecar name entries whose blobs are still pending in
// LATER ops (a false durability claim if the process dies in between). A crash
// between the file write and the queue draining can still lose the last
// in-flight entries; everything already flushed survives as the pending
// sidecar. finalize() awaits the queue; the sidecar is cleared only by
// commit(anchorSeq) AFTER the caller appended the point — a crash in between
// leaves a sidecar that recoverPending() recognises as already-recorded.
import { readFile } from "node:fs/promises"
import { normalizeRelPath, workspaceAbsPath } from "./path.ts"
import { sha256Hex, type RewindStore } from "./store.ts"
import type { FileStatus, RewindFileRecord, RewindPendingTurn, RewindPoint } from "./types.ts"

export interface RewindTakeResult {
  /** sha256 blob id of the pre-image; null when the file did not exist. */
  blobId: string | null
  isNewFile: boolean
}

interface PendingEntry {
  path: string
  before: Uint8Array | null
  blobId: string | null
  isNewFile: boolean
}

interface PendingTurn {
  anchorSeq: number
  promptPreview: string
  startedAt: number
  entries: Map<string, PendingEntry>
}

export interface RewindRecorderOptions {
  store: RewindStore
  /** Workspace root — finalize() re-reads touched files from here. */
  workspace: string
  /** M54 G2: notified when a durable pending-turn write fails. The journal is
   * a backend concern — recording continues; the failure is loud, not silent. */
  onDurabilityError?: (err: unknown) => void
}

const defaultDurabilityError = (err: unknown): void => {
  console.warn(`[rewind] pending-turn persistence failed: ${err instanceof Error ? err.message : String(err)}`)
}

export class RewindRecorder {
  private pending: PendingTurn | null = null
  /** Serial durable-write queue (see the header). Errors are reported through
   * onDurabilityError and never poison later writes. */
  private queue: Promise<void> = Promise.resolve()
  private readonly onDurabilityError: (err: unknown) => void

  constructor(private readonly opts: RewindRecorderOptions) {
    this.onDurabilityError = opts.onDurabilityError ?? defaultDurabilityError
  }

  /**
   * Open a new recording turn. FIRST-WINS per turn: a mid-turn spliced
   * user/message (input tiers promote queued messages in log order) must not
   * re-anchor the turn — the first message is the turn's origin. After a
   * turn/end finalize, the next begin opens the fresh turn.
   *
   * M54 G2: begin() also opens the durable sidecar (empty entry list), so a
   * crash before the first take still records that a turn was in flight.
   */
  begin(anchorSeq: number, promptPreview: string): void {
    if (this.pending !== null) return
    const turn: PendingTurn = { anchorSeq, promptPreview, startedAt: Date.now(), entries: new Map() }
    this.pending = turn
    // Eager snapshot — this op claims only what preceding ops already wrote.
    const snap = this.snapshot(turn)
    void this.enqueue(() => this.opts.store.writePending(snap))
  }

  /**
   * Capture a pre-image (beforeBytes null = the file is NEW). Synchronous —
   * fs tools hold the bytes and must not await between their read and write.
   * Returns { blobId, isNewFile } for the tool result's preImageRef/isNewFile.
   *
   * - No pending turn (tool running outside the agent loop) → capture is
   *   dropped (nothing to finalize into); the result carries
   *   { blobId: null, isNewFile: false }.
   * - A path already taken this turn → the FIRST entry's id is returned
   *   unchanged (take-once per (turn, path)).
   * - Path guards: normalizeRelPath refuses absolute / `..` / empty
   *   (REWIND_PATH_REFUSED — fail-loud: the fs layer already pre-filters
   *   out-of-workspace paths, so a refusal means a bug).
   *
   * M54 G2: a first take enqueues the durable blob + sidecar update (see the
   * header). Await flush() to observe it on disk.
   */
  take(relPath: string, beforeBytes: Uint8Array | null): RewindTakeResult {
    if (this.pending === null) return { blobId: null, isNewFile: false }
    const path = normalizeRelPath(relPath)
    const existing = this.pending.entries.get(path)
    if (existing !== undefined) {
      return { blobId: existing.blobId, isNewFile: existing.isNewFile }
    }
    const blobId = beforeBytes === null ? null : sha256Hex(beforeBytes)
    const entry: PendingEntry = { path, before: beforeBytes, blobId, isNewFile: beforeBytes === null }
    this.pending.entries.set(path, entry)
    const turn = this.pending
    // Eager snapshot (M54 review): this op's sidecar names only entries whose
    // blobs preceding ops already wrote — never a blob still pending in a
    // later op. The LAST op's snapshot still carries the full set.
    const snap = this.snapshot(turn)
    void this.enqueue(async () => {
      if (entry.before !== null) await this.opts.store.writeBlob(entry.before)
      await this.opts.store.writePending(snap)
    })
    return { blobId, isNewFile: entry.isNewFile }
  }

  /** M54 G2: await every queued durable pending write (tests / shutdown). */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Close the turn: persist pre-image blobs, re-read the touched set and
   * compute each file's afterHash (the cheap — touched-set-only — snapshot
   * the plan compares against). Returns the point (turnIndex = current journal
   * length) or null when no turn is pending. The pending turn is SNAPSHOT then
   * cleared first, so a concurrent next-turn begin cannot interleave.
   *
   * M54 G2: the durable sidecar is NOT cleared here — the caller clears it via
   * commit(anchorSeq) once the point is in the journal (a crash in between
   * must not make the turn vanish).
   *
   * v1 approximation (honest): a touched file that fails to re-read (ENOENT
   * or any read error) is treated as absent at turn end → status "deleted".
   */
  async finalize(): Promise<RewindPoint | null> {
    const pending = this.pending
    this.pending = null
    if (pending === null) return null

    // M54 G2: every take-time durable write for THIS turn must have landed
    // before the point is built (and before any sidecar clear can race it).
    await this.queue

    const files: RewindFileRecord[] = []
    for (const entry of pending.entries.values()) {
      let after: Uint8Array | null = null
      try {
        after = new Uint8Array(await readFile(workspaceAbsPath(this.opts.workspace, entry.path)))
      } catch {
        after = null
      }
      const afterHash = after === null ? undefined : sha256Hex(after)
      // status semantics: "added" — the file did not exist before the turn
      // (even when it was removed again inside the turn); "deleted" — it
      // existed (pre-image recordable) and is gone at turn end.
      const status: FileStatus = entry.isNewFile ? "added" : afterHash === undefined ? "deleted" : "modified"
      if (entry.before !== null) await this.opts.store.writeBlob(entry.before)
      files.push({
        path: entry.path,
        status,
        isNewFile: entry.isNewFile,
        ...(entry.blobId !== null ? { preBlob: entry.blobId } : {}),
        ...(afterHash !== undefined ? { afterHash } : {}),
      })
    }

    const turnIndex = (await this.opts.store.readPoints()).length
    return {
      turnIndex,
      anchorSeq: pending.anchorSeq,
      promptPreview: pending.promptPreview,
      files,
    }
  }

  /**
   * M54 G2: the point for this turn is now in the journal — clear its durable
   * sidecar. Pass the point's anchorSeq so a sidecar that already belongs to a
   * NEWER turn is left alone.
   *
   * M54 final-review F1: the clear runs on the SAME serial queue as the
   * take-time sidecar writes. A bare read+unlink here could interleave with a
   * queued writePending for a NEWER turn: the read sees the old sidecar, the
   * newer write lands, then the unlink deletes the NEWER sidecar — a crash
   * before that turn's next take loses its report (the G2 symptom in a narrow
   * window). Serialized, the anchorSeq check makes both orderings safe: a
   * clear queued BEFORE the newer write removes only the old sidecar; one
   * queued AFTER it sees the newer anchorSeq and leaves it alone.
   */
  async commit(anchorSeq: number): Promise<void> {
    await this.enqueue(() => this.opts.store.clearPending(anchorSeq))
  }

  private snapshot(turn: PendingTurn): RewindPendingTurn {
    return {
      version: 1,
      anchorSeq: turn.anchorSeq,
      promptPreview: turn.promptPreview,
      startedAt: turn.startedAt,
      entries: [...turn.entries.values()].map((e) => ({ path: e.path, blobId: e.blobId, isNewFile: e.isNewFile })),
    }
  }

  /** Append one op to the serial durable-write queue. The returned promise
   * settles when THIS op has run (errors are reported through
   * onDurabilityError, never rethrown) — await it to observe the op on disk. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op).catch((err) => {
      this.onDurabilityError(err)
    })
    this.queue = next
    return next
  }
}
