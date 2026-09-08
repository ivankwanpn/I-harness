// packages/rewind/src/store.ts — RewindStore: the storage side of the spec's
// layout `rewind/<sessionId>/{points.jsonl, blobs/<sha256>}`.
//
// - points.jsonl: one JSON RewindPoint per line, appended via atomic
//   temp+rename (the journal is small — appendPoint rewrites the file; the
//   red line in the spec applies to the SESSION log, not this journal).
// - blobs/<sha256>: content-addressed pre-images — same bytes ⇒ same file;
//   written only if missing (idempotent, dedup across turns).
// - meta.json (M54 G3): the journal's workspace binding — the absolute
//   workspace root the relative journal paths resolve against. Written on the
//   first write when a workspace is configured. Enforcement lives on the
//   caller surfaces, NOT on the raw file accessors: RewindService.points/
//   plan/execute call assertWorkspace() and refuse a foreign journal
//   (REWIND_WORKSPACE_MISMATCH), and every write path goes through
//   ensureDir(), which refuses to write when the binding differs — so a resume
//   from another cwd can never restore into the wrong tree. The raw read
//   accessors (readPoints/readBlob/readPending/readOrphans) are unguarded by
//   design and assume the caller already checked; recoverPending() guards
//   itself (it can unlink). A pre-M54 journal has no meta.json: unknown
//   workspace, kept working and adopted by the first workspace that writes.
// - pending.json (M54 G2): the durable sidecar of the turn currently being
//   recorded — written as the recorder takes pre-images, cleared only once the
//   turn's point is in the journal. A leftover sidecar after a crash is an
//   unfinished turn: recoverPending() archives it into orphaned.jsonl (an
//   HONEST artifact — never a fabricated point, never an auto-restore).
// - Guards: blob ids must be lowercase sha256 hex; the session key must not
//   carry path separators (footgun: sessionId lands in the path).
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, unlink } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { writeFileAtomic } from "@i-harness/fs"
import { RewindError } from "./error.ts"
import type {
  RewindOrphanRecord,
  RewindPendingEntry,
  RewindPendingTurn,
  RewindPoint,
  RewindWorkspaceMeta,
} from "./types.ts"

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Sane-session-key guard (the key lands in a filesystem path). */
function assertSessionKey(sessionId: string): void {
  if (sessionId.length === 0 || /[\\/]/.test(sessionId) || sessionId.includes("..")) {
    throw new RewindError("REWIND_INVALID", `invalid sessionId for rewind store: ${JSON.stringify(sessionId)}`)
  }
}

const BLOB_ID_RE = /^[a-f0-9]{64}$/

/** Same absolute directory? `resolve` normalizes separators/trailing slashes;
 * win32 `relative` compares case-insensitively. */
function sameWorkspacePath(a: string, b: string): boolean {
  const ra = resolve(a)
  const rb = resolve(b)
  return ra === rb || relative(ra, rb) === ""
}

/** Validate a pending-turn record (sidecar or archived orphan line). */
function parsePendingTurn(value: unknown, source: string): RewindPendingTurn {
  const corrupt = (why: string): never => {
    throw new RewindError("REWIND_STORE_CORRUPT", `${source}: ${why}`)
  }
  if (typeof value !== "object" || value === null) corrupt("not an object")
  const v = value as Record<string, unknown>
  if (v["version"] !== 1) corrupt(`unsupported version ${JSON.stringify(v["version"])}`)
  if (typeof v["anchorSeq"] !== "number" || !Number.isInteger(v["anchorSeq"])) corrupt("anchorSeq must be an integer")
  if (typeof v["promptPreview"] !== "string") corrupt("promptPreview must be a string")
  const rawEntries = v["entries"]
  if (!Array.isArray(rawEntries)) corrupt("entries must be an array")
  const entries: RewindPendingEntry[] = (rawEntries as unknown[]).map((raw: unknown, i: number) => {
    if (typeof raw !== "object" || raw === null) corrupt(`entries[${i}] is not an object`)
    const e = raw as Record<string, unknown>
    if (typeof e["path"] !== "string" || e["path"] === "") corrupt(`entries[${i}].path must be a non-empty string`)
    const blobId = e["blobId"]
    if (blobId !== null && (typeof blobId !== "string" || !BLOB_ID_RE.test(blobId))) {
      corrupt(`entries[${i}].blobId must be null or a sha256 hex id`)
    }
    if (typeof e["isNewFile"] !== "boolean") corrupt(`entries[${i}].isNewFile must be a boolean`)
    return { path: e["path"] as string, blobId: blobId as string | null, isNewFile: e["isNewFile"] as boolean }
  })
  return {
    version: 1,
    anchorSeq: v["anchorSeq"] as number,
    promptPreview: v["promptPreview"] as string,
    startedAt: typeof v["startedAt"] === "number" ? v["startedAt"] : 0,
    entries,
  }
}

export interface RewindStoreOptions {
  /** Parent of the rewind layout — `<root>/rewind/<sessionId>/…`. */
  root: string
  sessionId: string
  /** M54 G3: the absolute workspace this journal is bound to. When set, the
   * store writes `meta.json` on its first write and `ensureDir()` (every write
   * path) refuses a journal bound elsewhere. The read-side surfaces enforce
   * the binding themselves via `assertWorkspace()` (RewindService.points/
   * plan/execute, assembly open); the raw read* accessors are unguarded.
   * Absent (legacy construction) → no binding is written and no mismatch is
   * detected. */
  workspace?: string
}

export class RewindStore {
  private readonly dir: string
  private readonly workspace: string | undefined
  /** Cached meta.json read; `undefined` = not read yet, `null` = absent. */
  private metaCache: RewindWorkspaceMeta | null | undefined

  constructor(opts: RewindStoreOptions) {
    assertSessionKey(opts.sessionId)
    this.dir = join(opts.root, "rewind", opts.sessionId)
    this.workspace = opts.workspace
  }

  /** Absolute points.jsonl path (tests / host tooling may read it). */
  get pointsFile(): string {
    return join(this.dir, "points.jsonl")
  }

  /** Absolute blobs dir. */
  get blobsDir(): string {
    return join(this.dir, "blobs")
  }

  /** Absolute store dir (rewind/<sessionId>). */
  get storeDir(): string {
    return this.dir
  }

  /** Absolute meta.json path (M54 G3 workspace binding). */
  get metaFile(): string {
    return join(this.dir, "meta.json")
  }

  /** Absolute pending.json path (M54 G2 durable pending-turn sidecar). */
  get pendingFile(): string {
    return join(this.dir, "pending.json")
  }

  /** Absolute orphaned.jsonl path (M54 G2 archived crashed turns). */
  get orphansFile(): string {
    return join(this.dir, "orphaned.jsonl")
  }

  /** Guarded blob file path; non-hex ids are a caller bug (REWIND_INVALID). */
  blobPath(id: string): string {
    if (!BLOB_ID_RE.test(id)) {
      throw new RewindError("REWIND_INVALID", `invalid blob id: ${JSON.stringify(id)}`)
    }
    return join(this.blobsDir, id)
  }

  /** All recorded points in order; missing journal reads as []. */
  async readPoints(): Promise<RewindPoint[]> {
    let text: string
    try {
      text = await readFile(this.pointsFile, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    const points: RewindPoint[] = []
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (line === "") continue
      try {
        points.push(JSON.parse(line) as RewindPoint)
      } catch {
        throw new RewindError("REWIND_STORE_CORRUPT", `points.jsonl: malformed line: ${line.slice(0, 80)}`)
      }
    }
    return points
  }

  /** Append one point — atomic temp+rename rewrite of the whole journal. */
  async appendPoint(point: RewindPoint): Promise<void> {
    const points = await this.readPoints()
    points.push(point)
    await this.writePoints(points)
  }

  /**
   * Truncate the journal keeping the first `keepCount` points (atomic
   * rewrite). Called by execute() after a successful rewind to before the
   * target turn — the turns ≥ target are undone, so their points no longer
   * describe the frontier. `keepCount < 0` is a caller bug (REWIND_INVALID).
   */
  async truncate(keepCount: number): Promise<void> {
    if (keepCount < 0) {
      throw new RewindError("REWIND_INVALID", `negative truncate count: ${keepCount}`)
    }
    const points = await this.readPoints()
    await this.writePoints(points.slice(0, keepCount))
  }

  private async writePoints(points: RewindPoint[]): Promise<void> {
    const lines = points.map((p) => JSON.stringify(p))
    await this.ensureDir()
    await writeFileAtomic(this.pointsFile, lines.length > 0 ? lines.join("\n") + "\n" : "")
  }

  /** Write a content-addressed blob (idempotent — same bytes ⇒ no rewrite). */
  async writeBlob(bytes: Uint8Array): Promise<string> {
    const id = sha256Hex(bytes)
    await this.ensureDir()
    await mkdir(this.blobsDir, { recursive: true })
    const path = this.blobPath(id)
    let exists = false
    try {
      await stat(path)
      exists = true
    } catch {
      // a stat error (ENOENT etc.) means "not there yet" → write below
    }
    if (!exists) await writeFileAtomic(path, bytes)
    return id
  }

  /** Read a blob; missing content ⇒ REWIND_BLOB_MISSING (restore retry data
   * should be preserved — execute() treats this as a had_error). */
  async readBlob(id: string): Promise<Uint8Array> {
    let data: Uint8Array
    try {
      data = new Uint8Array(await readFile(this.blobPath(id)))
    } catch {
      throw new RewindError("REWIND_BLOB_MISSING", `pre-image blob not found: ${id}`)
    }
    return data
  }

  async hasBlob(id: string): Promise<boolean> {
    // Guard OUTSIDE the try — an invalid id is a caller bug (fail loud), not
    // a "not present" answer.
    const path = this.blobPath(id)
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /** Test/lifecycle helper — best-effort removal of a blob. Never throws. */
  async removeBlob(id: string): Promise<void> {
    await unlink(this.blobPath(id)).catch(() => {})
  }

  // ── M54 G3: workspace binding ──────────────────────────────────────────────

  /**
   * The journal's workspace binding. `null` = no meta.json (pre-M54 journal —
   * unknown workspace). Malformed meta.json ⇒ REWIND_STORE_CORRUPT (loud: a
   * corrupt binding must never be silently ignored).
   */
  async readMeta(): Promise<RewindWorkspaceMeta | null> {
    if (this.metaCache !== undefined) return this.metaCache
    let text: string
    try {
      text = await readFile(this.metaFile, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.metaCache = null
        return null
      }
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RewindError("REWIND_STORE_CORRUPT", "meta.json: malformed JSON")
    }
    const ws = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["workspace"] : undefined
    if (typeof ws !== "string" || ws === "") {
      throw new RewindError("REWIND_STORE_CORRUPT", "meta.json: missing workspace")
    }
    const meta: RewindWorkspaceMeta = { version: 1, workspace: ws }
    this.metaCache = meta
    return meta
  }

  /**
   * Fail loud (REWIND_WORKSPACE_MISMATCH) when this journal is bound to a
   * different workspace than `workspace`. A missing meta.json (pre-M54) is
   * NOT a mismatch — the binding is unknown and stays usable.
   */
  async assertWorkspace(workspace: string): Promise<void> {
    const meta = await this.readMeta()
    if (meta === null) return
    if (!sameWorkspacePath(meta.workspace, workspace)) {
      throw new RewindError(
        "REWIND_WORKSPACE_MISMATCH",
        `rewind journal ${this.dir} is bound to workspace ${meta.workspace}; refusing to operate from ${workspace}`,
      )
    }
  }

  /** Create the dir + bind/adopt the workspace. Throws REWIND_WORKSPACE_MISMATCH
   * when the journal is bound elsewhere (a foreign journal must never be
   * polluted by this workspace's writes). */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const meta = await this.readMeta()
    if (meta === null) {
      if (this.workspace === undefined) return
      const written: RewindWorkspaceMeta = { version: 1, workspace: resolve(this.workspace) }
      await writeFileAtomic(this.metaFile, JSON.stringify(written) + "\n")
      this.metaCache = written
      // The one irreversible decision (a pre-M54 journal has no binding) is
      // never silent: the adoption is reported so a wrong-cwd first write is
      // at least visible in the host log.
      console.warn(`[rewind] bound pre-M54 journal ${this.dir} to workspace ${written.workspace} (no meta.json existed)`)
      return
    }
    if (this.workspace !== undefined && !sameWorkspacePath(meta.workspace, this.workspace)) {
      throw new RewindError(
        "REWIND_WORKSPACE_MISMATCH",
        `rewind journal ${this.dir} is bound to workspace ${meta.workspace}; refusing to write from ${this.workspace}`,
      )
    }
  }

  // ── M54 G2: durable pending turn + honest recovery ─────────────────────────

  /** The live pending-turn sidecar (a turn still being recorded). Missing ⇒ null. */
  async readPending(): Promise<RewindPendingTurn | null> {
    let text: string
    try {
      text = await readFile(this.pendingFile, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RewindError("REWIND_STORE_CORRUPT", "pending.json: malformed JSON")
    }
    return parsePendingTurn(parsed, "pending.json")
  }

  /** Write/refresh the pending-turn sidecar (atomic temp+rename). */
  async writePending(turn: RewindPendingTurn): Promise<void> {
    await this.ensureDir()
    await writeFileAtomic(this.pendingFile, JSON.stringify(turn) + "\n")
  }

  /**
   * Clear the pending sidecar. With `anchorSeq`, only a sidecar belonging to
   * THAT turn is cleared — a newer turn that began in the meantime keeps its
   * own sidecar. A corrupt sidecar is left in place (never silently dropped).
   */
  async clearPending(anchorSeq?: number): Promise<void> {
    if (anchorSeq !== undefined) {
      let pending: RewindPendingTurn | null
      try {
        pending = await this.readPending()
      } catch {
        return
      }
      if (pending === null || pending.anchorSeq !== anchorSeq) return
    }
    await unlink(this.pendingFile).catch(() => {})
  }

  /**
   * Recovery entry point (M54 G2) — call when a store/session is (re)opened,
   * before recording begins. A leftover sidecar whose turn has NO point in the
   * journal is archived to orphaned.jsonl and returned (the caller may warn);
   * a sidecar whose point IS recorded was a completed turn that crashed
   * between append and clear — it is simply dropped (nothing was lost).
   *
   * Honesty: no point is fabricated and nothing is restored — the archive is
   * the artifact plan() reports.
   */
  async recoverPending(): Promise<RewindPendingTurn | null> {
    // M54 final-review F2: recovery can UNLINK (the already-recorded branch
    // below) and is reachable on the assembly's workspace-mismatch path, so it
    // must guard the binding itself — the raw read* accessors do not. A
    // foreign journal is left COMPLETELY untouched (no archive, no unlink);
    // its owning workspace still recovers it on its next open.
    if (this.workspace !== undefined) {
      const meta = await this.readMeta()
      if (meta !== null && !sameWorkspacePath(meta.workspace, this.workspace)) return null
    }
    const pending = await this.readPending()
    if (pending === null) return null
    const points = await this.readPoints()
    if (points.some((p) => p.anchorSeq === pending.anchorSeq)) {
      await this.clearPending(pending.anchorSeq)
      return null
    }
    const orphan: RewindOrphanRecord = { ...pending, recoveredAt: Date.now() }
    await this.appendOrphan(orphan)
    await this.clearPending(pending.anchorSeq)
    return pending
  }

  /** Archived crashed/unfinished turns, in crash order (missing ⇒ []). */
  async readOrphans(): Promise<RewindOrphanRecord[]> {
    let text: string
    try {
      text = await readFile(this.orphansFile, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    const orphans: RewindOrphanRecord[] = []
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (line === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new RewindError("REWIND_STORE_CORRUPT", `orphaned.jsonl: malformed line: ${line.slice(0, 80)}`)
      }
      const turn = parsePendingTurn(parsed, "orphaned.jsonl")
      const recoveredAt = (parsed as Record<string, unknown>)["recoveredAt"]
      orphans.push({ ...turn, recoveredAt: typeof recoveredAt === "number" ? recoveredAt : 0 })
    }
    return orphans
  }

  /**
   * A leftover sidecar whose turn has NO point in the journal (a crashed turn
   * recovery has not archived yet). Null when absent or already recorded —
   * `plan()` can therefore report an un-recovered sidecar without recovery.
   */
  async readUnresolvedPending(points?: RewindPoint[]): Promise<RewindPendingTurn | null> {
    const pending = await this.readPending()
    if (pending === null) return null
    const recorded = points ?? (await this.readPoints())
    return recorded.some((p) => p.anchorSeq === pending.anchorSeq) ? null : pending
  }

  /** Add one orphan line. LOGICALLY append-only (records are never removed or
   * rewritten), but implemented as an atomic read-modify-write rewrite of the
   * whole file — a plain append could tear a line and corrupt the archive. */
  private async appendOrphan(orphan: RewindOrphanRecord): Promise<void> {
    const orphans = await this.readOrphans()
    orphans.push(orphan)
    await this.ensureDir()
    await writeFileAtomic(this.orphansFile, orphans.map((o) => JSON.stringify(o)).join("\n") + "\n")
  }
}
