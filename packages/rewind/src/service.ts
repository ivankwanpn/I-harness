// packages/rewind/src/service.ts — RewindService: the rewind operation's
// host-facing engine (spec §3): points() list, plan() two-phase dry-run,
// execute() file restore + conversation shadow marker (the rewind/point event
// via the injected appendEvent) + journal truncate.
//
// SEMANTICS (v1, documented loudly — deviations from the draft spec §3):
//
// Rewind to target turn T = bring the disk + conversation back to the state
// at the END of turn T-1 (i.e. undo turn T and everything after it). The
// point of turn T stores exactly the material this needs: the pre-images of
// the files T changed (blobs) and the files T created (delete-added). The
// afterHash per file is the plan's LAZY COMPARISON signal: current disk hash
// vs afterHash distinguishes "the turn's deltas are still in place" (clean)
// from "the disk moved on since the turn ended" (conflict).
//
// Conflict classification (ConflictType, externally-changed-after-target):
//   "modified" — file existed at T's end (afterHash present), current content
//                 differs → an external write happened after the turn (grok:
//                 rewind executes ANYWAY, honestly marked — a rewind is
//                 destructive by design).
//   "deleted"  — file existed at T's end, current disk is missing it
//                 (externally deleted; the restore re-creates it from the
//                 pre-image and marks the conflict).
//   "created"  — file was ABSENT at T's end (it was deleted in turn T, or
//                 created-and-removed inside T), current disk has it
//                 (externally recreated since).
//
// unTracked (v1 honest scope — the spec's "无 pre-image 的文件（shell 触摸）
// → un-tracked 诚实列出、不猜测恢复" drafts this; the authoritative reading):
//   paths touched in RECORDED turns after the target, not in the target
//   point's set. A restore does not touch them (they are not in T's point),
//   yet the conversation projection hides the later turns that recorded
//   them, so the disk keeps changes the log no longer explains. The engine
//   LISTS them, never guesses. SHELL-only changes (no recorder → no record)
//   are entirely invisible: the recorder sees ONLY fs tool writes
//   (write/edit/apply_patch) — anything modified via bash/ripgrep never
//   appears in plan().unTracked and is not protected by a rewind. That is a
//   documented v1 limitation of the engine (the 红线's honest scope).
//
// had_errors: any file op failure (missing blob, disk IO) keeps points.jsonl
// intact (retry data, spec §3) — the rewind/point event is still appended and
// the result carries the errors.
import { readFile, stat, unlink, writeFile } from "node:fs/promises"
import { workspaceAbsPath } from "./path.ts"
import { sha256Hex, type RewindStore } from "./store.ts"
import { RewindError } from "./error.ts"
import type {
  ConflictOp,
  ConflictType,
  FileOp,
  RewindEvent,
  RewindMode,
  RewindPlan,
  RewindPoint,
  RewindPointSummary,
  RewindResult,
} from "./types.ts"

export interface RewindServiceOptions {
  store: RewindStore
  /** Workspace root the journal paths resolve against (plan/execute disk side). */
  workspace: string
}

export interface RewindExecuteHooks {
  /** Append the rewind/point conversation marker into the session log. */
  appendEvent(ev: RewindEvent): void
  /**
   * Optional seam for the live in-memory view (G2 owns deriveMessages'
   * cutSeq projection — the projection reads the marker from the log itself,
   * so this hook is a notification, not the mechanism). Called with the
   * anchorSeq: everything from this seq onward is hidden on the model surface.
   */
  deriveSkip?(anchorSeq: number): void
}

async function diskHash(workspace: string, relPath: string): Promise<string | null> {
  const abs = workspaceAbsPath(workspace, relPath)
  try {
    return sha256Hex(new Uint8Array(await readFile(abs)))
  } catch {
    return null
  }
}

/** The op that restores this record: isNewFile → delete-added (when the file
 * still exists), else rewrite the pre-image blob. */
function opFor(record: RewindPoint["files"][number], diskPresent: boolean): FileOp | null {
  if (record.isNewFile) {
    return diskPresent ? { path: record.path, kind: "delete-added" } : null
  }
  return { path: record.path, kind: "restore-blob", blobId: record.preBlob }
}

function classify(record: RewindPoint["files"][number], current: string | null): ConflictType | null {
  if (record.afterHash !== undefined) {
    if (current === null) return "deleted"
    if (current !== record.afterHash) return "modified"
    return null
  }
  // target end state = file absent
  if (current !== null) return "created"
  return null
}

export class RewindService {
  private readonly store: RewindStore
  private readonly workspace: string

  constructor(opts: RewindServiceOptions) {
    this.store = opts.store
    this.workspace = opts.workspace
  }

  async points(): Promise<RewindPointSummary[]> {
    const points = await this.store.readPoints()
    return points.map((p) => ({
      turnIndex: p.turnIndex,
      preview: p.promptPreview.slice(0, 120),
      files: p.files.length,
    }))
  }

  /**
   * Lazy two-phase dry run against the target point. `clean` = files whose
   * current disk state still equals the recorded after-state (restore is a
   * pure replay of the point's pre-images); `conflicts` = externally
   * diverged (still listed in `ops` — a rewind executes conflicts anyway);
   * `unTracked` = later-recorded paths the restore does not cover (see the
   * header for the honest-scope pitfalls). `ops` = the executable file-op
   * list (empty for mode "conversation").
   */
  async plan(targetTurnIndex: number, mode: RewindMode = "all"): Promise<RewindPlan> {
    const points = await this.store.readPoints()
    const target = this.pointAt(points, targetTurnIndex)

    const clean: FileOp[] = []
    const ops: FileOp[] = []
    const conflicts: ConflictOp[] = []
    for (const record of target.files) {
      const current = await diskHash(this.workspace, record.path)
      const conflict = classify(record, current)
      const op = opFor(record, current !== null)
      if (conflict !== null) conflicts.push({ path: record.path, kind: conflict })
      if (op !== null) {
        ops.push(op)
        if (conflict === null) clean.push(op)
      }
    }

    // unTracked — recorded-later-touched paths outside the target's set.
    const targetPaths = new Set(target.files.map((f) => f.path))
    const unTracked = new Set<string>()
    for (const later of points.slice(targetTurnIndex + 1)) {
      for (const f of later.files) if (!targetPaths.has(f.path)) unTracked.add(f.path)
    }

    return {
      target: targetTurnIndex,
      mode,
      clean,
      conflicts,
      unTracked: [...unTracked].sort(),
      ops: mode === "conversation" ? [] : ops,
    }
  }

  /**
   * Apply the rewind: file ops first (restore from pre-image blobs / delete
   * added files — conflicts executed anyway, marked), then the conversation
   * shadow marker via appendEvent, then journal truncate when no errors and
   * the mode is not "files" (a files-only restore leaves the conversation
   * frontier in place, so the journal must keep it).
   */
  async execute(
    targetTurnIndex: number,
    mode: RewindMode,
    hooks: RewindExecuteHooks,
  ): Promise<RewindResult> {
    const points = await this.store.readPoints()
    const target = this.pointAt(points, targetTurnIndex)
    const plan = await this.plan(targetTurnIndex, mode)

    const errors: { path: string; message: string }[] = []
    let revertedFiles = 0
    if (mode !== "conversation") {
      for (const op of plan.ops) {
        try {
          if (op.kind === "delete-added") {
            const abs = workspaceAbsPath(this.workspace, op.path)
            try {
              await stat(abs)
            } catch {
              continue // already gone — nothing to delete
            }
            await unlink(abs)
            revertedFiles += 1
          } else {
            const data = await this.store.readBlob(op.blobId!)
            await writeFile(workspaceAbsPath(this.workspace, op.path), data)
            revertedFiles += 1
          }
        } catch (err) {
          errors.push({ path: op.path, message: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    const event: RewindEvent = {
      type: "rewind/point",
      version: 1,
      targetTurn: targetTurnIndex,
      anchorSeq: target.anchorSeq,
      mode,
      fileOps: plan.ops.map((o) => ({ path: o.path, op: o.kind === "restore-blob" ? "restore" : "delete" })),
    }
    hooks.appendEvent(event)
    hooks.deriveSkip?.(target.anchorSeq)

    // had_errors ⇒ keep points (retry data, spec §3). A files-only rewind
    // never truncates (the conversation frontier is unchanged).
    const truncated = errors.length === 0 && mode !== "files"
    if (truncated) await this.store.truncate(targetTurnIndex)

    return {
      target: targetTurnIndex,
      mode,
      revertedFiles,
      conflicts: plan.conflicts,
      errors,
      truncated,
      eventAppended: true,
    }
  }

  private pointAt(points: RewindPoint[], targetTurnIndex: number): RewindPoint {
    if (!Number.isInteger(targetTurnIndex) || targetTurnIndex < 0 || targetTurnIndex >= points.length) {
      throw new RewindError(
        "REWIND_TARGET_INVALID",
        `target turn ${targetTurnIndex} out of range (points: ${points.length})`,
      )
    }
    return points[targetTurnIndex]!
  }
}
