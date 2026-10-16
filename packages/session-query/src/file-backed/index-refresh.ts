import type { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { CURRENT_FORMAT_VERSION, deriveSearchText, type SessionEvent } from "@i-harness/core-session"
import { observeFailed, type FileBackedQueryOptions, type HeaderMeta, type IndexedRow } from "./contracts.ts"
import { createStoreScanner, parseLinePrefix, revisionOf } from "./inspection.ts"

const STABLE_OBSERVATION_ATTEMPTS = 2

/** Owns the single reconcile chain for one database; every query joins it. */
export function createIndexRefresh(
  db: DatabaseSync,
  storeRoot: string,
  signal: FileBackedQueryOptions["signal"],
  onInspect: FileBackedQueryOptions["onInspect"],
): () => Promise<void> {
  // Serially reconcile concurrent observers (single-flight chain).
  let reconcileChain: Promise<void> = Promise.resolve()
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    const next = reconcileChain.then(fn, fn)
    reconcileChain = next
    return next
  }

  const signalGuard = (): void => {
    if (signal?.aborted) throw new Error("session query aborted")
  }

  const scanStore = createStoreScanner(storeRoot, signalGuard)

  async function rebuildSession(id: string, rev: string, file: string): Promise<void> {
    const bytes = await readFile(file)
    // Fail-loud wrap: a corrupt header/torn-beginning source is an observe
    // failure — never a raw SyntaxError, and never stale rows.
    let header: HeaderMeta
    let events: SessionEvent[]
    let contentLines: string[]
    let contentBytes: Uint8Array | undefined
    try {
      const decoded = parseLinePrefix(bytes)
      header = decoded.header
      events = decoded.events
      contentLines = decoded.contentLines
      contentBytes = decoded.contentBytes
    } catch (err) {
      throw observeFailed(`decode ${id}`, err)
    }
    if (header.formatVersion > CURRENT_FORMAT_VERSION) {
      throw observeFailed(`decode ${id}`, new Error(`format version ${header.formatVersion} is newer than this build (upgrade the harness)`))
    }
    const fingerprint = createHash("sha256").update(contentBytes ?? contentLines.join("\n")).digest("hex")
    const indexed = db.prepare("SELECT id, revision, fingerprint FROM indexed_sessions WHERE id = ?").get(id) as IndexedRow | undefined
    if (indexed !== undefined && indexed.fingerprint === fingerprint) {
      // fingerprint guard: the stat changed but the content is byte-identical —
      // rows stay valid; only the revision row advances.
      db.prepare("UPDATE indexed_sessions SET revision = ? WHERE id = ?").run(rev, id)
      onInspect?.(id, "content-equal")
      return
    }

    // One BEGIN IMMEDIATE txn per changed session (delete + insert the whole
    // id's rows + fingerprint) — a torn rebuild is atomic, never half-served.
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare("DELETE FROM indexed_docs WHERE session_id = ?").run(id)
      db.prepare("DELETE FROM lineage WHERE id = ?").run(id)
      const insertDoc = db.prepare("INSERT INTO indexed_docs (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i]!
        insertDoc.run(id, ev.seq ?? i, ev.type, Date.now(), deriveSearchText(ev))
      }
      const created = Date.parse(header.createdAt)
      db.prepare(
        `INSERT INTO lineage (id, created_at, cwd, parent_session, seed_length, delegation_depth, origin)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        id,
        Number.isNaN(created) ? 0 : created,
        header.parentSession ?? null,
        header.seedLength ?? null,
        header.delegationDepth ?? null,
        header.origin ?? null,
      )
      db.prepare(
        `INSERT INTO indexed_sessions (id, revision, fingerprint) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, fingerprint = excluded.fingerprint`,
      ).run(id, rev, fingerprint)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    onInspect?.(id, "indexed")
  }

  async function removeSession(id: string): Promise<void> {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare("DELETE FROM indexed_docs WHERE session_id = ?").run(id)
      db.prepare("DELETE FROM lineage WHERE id = ?").run(id)
      db.prepare("DELETE FROM indexed_sessions WHERE id = ?").run(id)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    onInspect?.(id, "removed")
  }

  /** One reconcile round: scan → diff → remove/rebuild/skip. */
  async function doReconcile(): Promise<void> {
    const snapshots = await scanStore()

    // Removals first: a deleted session file must stop matching immediately.
    const indexed = db.prepare("SELECT id FROM indexed_sessions").all() as { id: string }[]
    for (const { id } of indexed) {
      if (!snapshots.has(id)) await removeSession(id)
    }

    for (const [id, snapshot] of snapshots) {
      signalGuard()
      const current = db.prepare("SELECT id, revision, fingerprint FROM indexed_sessions WHERE id = ?").get(id) as IndexedRow | undefined
      if (current !== undefined && current.revision === snapshot.revision) {
        onInspect?.(id, "skip")
        continue
      }
      // Stable observation (dsh STABLE_OBSERVATION_ATTEMPTS): re-stat after the
      // read; a concurrent writer flips the revision → retry once, then fail
      // loud rather than index a moving target.
      let rev = snapshot.revision
      for (let attempt = 1; attempt <= STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
        await rebuildSession(id, rev, snapshot.file)
        const after = await stat(snapshot.file)
        const afterRev = revisionOf(after)
        if (afterRev === rev) break
        if (attempt === STABLE_OBSERVATION_ATTEMPTS) {
          throw observeFailed(`stable observation of ${id}`, new Error("file kept changing across retries"))
        }
        rev = afterRev
      }
    }
  }

  return () => serialize(doReconcile)
}
