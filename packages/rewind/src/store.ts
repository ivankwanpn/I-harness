// packages/rewind/src/store.ts — RewindStore: the storage side of the spec's
// layout `rewind/<sessionId>/{points.jsonl, blobs/<sha256>}`.
//
// - points.jsonl: one JSON RewindPoint per line, appended via atomic
//   temp+rename (the journal is small — appendPoint rewrites the file; the
//   red line in the spec applies to the SESSION log, not this journal).
// - blobs/<sha256>: content-addressed pre-images — same bytes ⇒ same file;
//   written only if missing (idempotent, dedup across turns).
// - Guards: blob ids must be lowercase sha256 hex; the session key must not
//   carry path separators (footgun: sessionId lands in the path).
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { writeFileAtomic } from "@i-harness/fs"
import { RewindError } from "./error.ts"
import type { RewindPoint } from "./types.ts"

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

export interface RewindStoreOptions {
  /** Parent of the rewind layout — `<root>/rewind/<sessionId>/…`. */
  root: string
  sessionId: string
}

export class RewindStore {
  private readonly dir: string

  constructor(opts: RewindStoreOptions) {
    assertSessionKey(opts.sessionId)
    this.dir = join(opts.root, "rewind", opts.sessionId)
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
    await mkdir(this.dir, { recursive: true })
    await writeFileAtomic(this.pointsFile, lines.length > 0 ? lines.join("\n") + "\n" : "")
  }

  /** Write a content-addressed blob (idempotent — same bytes ⇒ no rewrite). */
  async writeBlob(bytes: Uint8Array): Promise<string> {
    const id = sha256Hex(bytes)
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
}
