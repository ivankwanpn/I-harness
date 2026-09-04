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
import { readFile } from "node:fs/promises"
import { normalizeRelPath, workspaceAbsPath } from "./path.ts"
import { sha256Hex, type RewindStore } from "./store.ts"
import type { FileStatus, RewindFileRecord, RewindPoint } from "./types.ts"

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
  entries: Map<string, PendingEntry>
}

export interface RewindRecorderOptions {
  store: RewindStore
  /** Workspace root — finalize() re-reads touched files from here. */
  workspace: string
}

export class RewindRecorder {
  private pending: PendingTurn | null = null

  constructor(private readonly opts: RewindRecorderOptions) {}

  /**
   * Open a new recording turn. FIRST-WINS per turn: a mid-turn spliced
   * user/message (input tiers promote queued messages in log order) must not
   * re-anchor the turn — the first message is the turn's origin. After a
   * turn/end finalize, the next begin opens the fresh turn.
   */
  begin(anchorSeq: number, promptPreview: string): void {
    if (this.pending !== null) return
    this.pending = { anchorSeq, promptPreview, entries: new Map() }
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
    return { blobId, isNewFile: entry.isNewFile }
  }

  /**
   * Close the turn: persist pre-image blobs, re-read the touched set and
   * compute each file's afterHash (the cheap — touched-set-only — snapshot
   * the plan compares against). Returns the point (turnIndex = current journal
   * length) or null when no turn is pending. The pending turn is SNAPSHOT then
   * cleared first, so a concurrent next-turn begin cannot interleave.
   *
   * v1 approximation (honest): a touched file that fails to re-read (ENOENT
   * or any read error) is treated as absent at turn end → status "deleted".
   */
  async finalize(): Promise<RewindPoint | null> {
    const pending = this.pending
    this.pending = null
    if (pending === null) return null

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
}
