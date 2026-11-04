import { open, readdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * S-08 (fork atomic publication): a forked/child session file exists from its
 * first bootstrap header write, but it is not a session until its bootstrap
 * birth frames (seed + completion) are durable. The rest of the storage layer
 * already fails closed on such a file (`SESSION_BOOTSTRAP_INCOMPLETE`), so the
 * only remaining exposure was `list()` advertising the half-built child.
 *
 * A sibling marker is the durable "publication pending" bit. It is written
 * (and fsynced, together with its directory) before the first session byte and
 * removed only after a completed bootstrap is observed. `list()` filters
 * marked files using the directory listing it already reads, so the filter
 * costs nothing; observation of a completed bootstrap clears the marker.
 */
const MARKER_SUFFIX = '.publishing'
const SESSION_MARKER_SUFFIX = '.jsonl.publishing'

export function publicationMarkerPath(sessionPath: string): string {
  return sessionPath + MARKER_SUFFIX
}

/** Session id carried by a marker filename, or undefined for any other name. */
export function publicationMarkerId(name: string): string | undefined {
  if (!name.endsWith(SESSION_MARKER_SUFFIX)) return undefined
  const id = name.slice(0, -SESSION_MARKER_SUFFIX.length)
  return id && !id.includes('\\') && !id.includes('/') ? id : undefined
}

export type PublicationOwner = {
  /** Durably record that `id`'s session file is not publishable yet. */
  begin(id: string, sessionPath: string): Promise<void>
  /** Clear the marker once a completed bootstrap has been observed. */
  end(id: string, sessionPath: string): Promise<void>
}

export function createPublicationOwner(rootPath: string): PublicationOwner {
  const pending = new Set<string>()
  let seeded: Promise<void> | undefined
  function seed(): Promise<void> {
    seeded ??= readdir(rootPath).then(names => {
      for (const name of names) {
        const id = publicationMarkerId(name)
        if (id !== undefined) pending.add(id)
      }
    }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    return seeded
  }
  return {
    async begin(id, sessionPath) {
      await seed().catch(() => {})
      if (pending.has(id)) return
      await writeMarker(publicationMarkerPath(sessionPath))
      pending.add(id)
    },
    async end(id, sessionPath) {
      await seed().catch(() => {})
      if (!pending.has(id)) return
      // Visibility is best effort: never turn a cleanup failure into a failed
      // read. A surviving marker is cleared by the next observation.
      try { await unlink(publicationMarkerPath(sessionPath)) } catch { return }
      pending.delete(id)
    },
  }
}

async function writeMarker(path: string): Promise<void> {
  let handle
  try { handle = await open(path, 'wx') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error }
  try { await handle.sync() } finally { await handle.close().catch(() => {}) }
  const directory = await open(dirname(path), 'r').catch(() => undefined)
  if (directory) { try { await directory.sync() } catch {} finally { await directory.close().catch(() => {}) } }
}
