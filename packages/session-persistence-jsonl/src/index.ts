import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail } from "./format.ts"

// C5 blank-probe cap (DSH coldBlankProbeMaxBytes parity, DSH default 1024): a
// session artifact at or under this size is read in full for the EXACT blank
// answer (no turn/start yet); a larger one is served non-blank without a read
// (honest-bounding: it may have content — never guessed blank).
const BLANK_PROBE_MAX_BYTES = 1024

async function replaceSessionFile(path: string, headerLine: string, events: SessionEvent[]): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  const body = [headerLine, ...events.map((event) => JSON.stringify(event)), ""].join("\n")
  const handle = await open(tmp, "wx")
  try {
    await handle.writeFile(body, { encoding: "utf-8" })
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  // Directory fsync is not supported uniformly on Windows. Best-effort keeps
  // the stronger durability path on platforms/filesystems that allow it.
  const directory = await open(dirname(path), "r").catch(() => undefined)
  if (directory !== undefined) {
    try { await directory.sync() } catch { /* best-effort */ }
    await directory.close().catch(() => {})
  }
}

export function createJsonlBackend(root: string): PersistenceBackend {
  const rootPath = resolve(root)
  const artifactPath = (id: string, suffix: string): string => {
    const portableId = id.replace(/\\/g, "/")
    const candidate = resolve(rootPath, `${portableId}${suffix}`)
    const fromRoot = relative(rootPath, candidate)
    const outside = posix.isAbsolute(portableId)
      || win32.parse(id).root !== ""
      || fromRoot === ".."
      || fromRoot.startsWith(`..${sep}`)
      || isAbsolute(fromRoot)
    if (outside) {
      throw new Error(`artifact ${JSON.stringify(id)} is outside the JSONL store root`)
    }
    return candidate
  }
  const filePath = (id: string) => artifactPath(id, ".jsonl")
  const docPath = (key: string) => artifactPath(key, ".doc.jsonl")
  const tombPath = (kind: string, id: string) => artifactPath(`desktop-deleted-${kind}-${createHash("sha256").update(id).digest("hex")}`, ".tombstone")
  async function assertNotDeleted(kind: string, id: string) {
    if (kind === "document") {
      const digest = /^(?:desktop-navigation-|desktop-session-project-|approval-history-|desktop-goal-|desktop-input-tokens-)([a-f0-9]{64})$/.exec(id)?.[1]
      if (digest) {
        try { await stat(artifactPath(`desktop-deleted-session-${digest}`, ".tombstone")); throw new Error("Session document is permanently deleted") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      } else {
        const owner = id.startsWith("session-title/") ? id.slice("session-title/".length) : id.startsWith("task-") ? id.slice("task-".length) : id
        await assertNotDeleted("session", owner)
      }
    }
    try { await stat(tombPath(kind, id)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    throw new Error("Session or document is permanently deleted")
  }
  async function confined(path: string) {
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (file?.isSymbolicLink()) throw new Error("Owned artifact is a symlink")
    for (let parent = dirname(path);;) {
      const row = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
      if (row?.isSymbolicLink()) throw new Error("Owned artifact parent is a symlink")
      if (parent === rootPath) break
      const next = dirname(parent)
      if (next === parent) throw new Error("Owned artifact is outside the store")
      parent = next
    }
  }
  async function deletionReceipt(sessionId: string) {
    if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) throw new Error("Invalid owned session identity")
    const path = tombPath("session", sessionId)
    await confined(path)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!info) return undefined
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Invalid deletion receipt")
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; sessionId?: unknown; visibility?: { origin?: string; parentSession?: string }; documents?: string[]; files?: string[] }
    // Older tombstones fence writes but lack the original visibility proof.
    if (value.version === 1) return undefined
    if (value.version !== 2 || value.sessionId !== sessionId || !value.visibility || typeof value.visibility !== "object" || Array.isArray(value.visibility)
      || Object.keys(value.visibility).some(key => !["origin", "parentSession"].includes(key))
      || Object.values(value.visibility).some(field => typeof field !== "string")
      || !Array.isArray(value.documents) || value.documents.some(key => typeof key !== "string") || !Array.isArray(value.files) || value.files.some(key => typeof key !== "string")) throw new Error("Invalid deletion receipt")
    return { visibility: value.visibility, manifest: { documents: value.documents, files: value.files } }
  }

  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    // M23: the coordinator's ownership lease defaults to the store root.
    lockRoot: root,
    deletionReceipt,

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      await assertNotDeleted("session", sessionId)
      await mkdir(rootPath, { recursive: true })
      // wx: fail if the session file already exists.
      await writeFile(filePath(sessionId), serializeHeader(meta) + "\n", { flag: "wx" })
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const handle = await open(path, "r+")
      let committedBytes = 0
      try {
        committedBytes = (await handle.stat()).size
        const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
        await handle.write(text, committedBytes)
        await handle.sync()
      } catch (err) {
        // F01-2 rollback: truncate back to the committed byte length so a
        // clean retry never duplicates seqs.
        await handle.truncate(committedBytes).catch(() => {})
        await handle.sync().catch(() => {})
        throw err
      } finally {
        await handle.close()
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      await assertNotDeleted("session", sessionId)
      const text = await readFile(filePath(sessionId), "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") throw new Error(`empty session file: ${sessionId}`)
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      return { version: header.formatVersion, events, meta: header }
    },

    async list(): Promise<string[]> {
      const names = await readdir(rootPath).catch(() => [] as string[])
      // Skip `.doc.jsonl` document sidecars — they are not sessions.
      const ids = names
        .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".doc.jsonl"))
        .map((n) => basename(n, ".jsonl"))
      return (await Promise.all(ids.map(async id => { try { await assertNotDeleted("session", id); return id } catch (error) { if ((error as Error).message.includes("permanently deleted")) return undefined; throw error } }))).filter((id): id is string => id !== undefined)
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      const headerLine = lines[0]!
      const header = parseHeader(headerLine)
      const events = parseEventLines(lines.slice(1))
      const torn = hasTornTail(lines.slice(1))
      const closers = missingClosers(events)
      if (torn || closers.length > 0) {
        await replaceSessionFile(path, headerLine, [...events, ...closers])
      }
      return { version: header.formatVersion, events: [...events, ...closers], meta: header }
    },

    async replaceEvents(sessionId, events) {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const text = await readFile(path, "utf-8")
      const headerLine = text.split("\n")[0]!
      parseHeader(headerLine)
      await replaceSessionFile(path, headerLine, events)
    },

    async profile(sessionId) {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const updatedAt = (await stat(path)).mtimeMs
      // Blank probe (coldBlankProbeMaxBytes policy): a small artifact is read
      // whole for the exact answer; a big one is served non-blank.
      if ((await stat(path)).size <= BLANK_PROBE_MAX_BYTES) {
        const lines = (await readFile(path, "utf-8")).split("\n")
        return {
          meta: parseHeader(lines[0]!),
          blank: parseEventLines(lines.slice(1)).every((ev) => ev.type !== "turn/start"), updatedAt,
        }
      }
      return { meta: await readHeader(path), blank: false, updatedAt }
    },

    async updateMeta(sessionId, patch) {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      // Header rewrite: replace line 0 only; event lines are kept byte-exact
      // (a torn tail is preserved as-is, repair's business). Atomic temp +
      // rename (putDocument pattern) — a concurrent reader sees either the
      // old or the new file, never a truncated one.
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") {
        throw new Error(`empty session file: ${sessionId}`)
      }
      const merged: SessionMeta = { ...parseHeader(lines[0]!), ...patch }
      const out = lines.slice()
      out[0] = serializeHeader(merged)
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, out.join("\n"), { encoding: "utf-8" })
      await rename(tmp, path)
      return merged
    },

    async putDocument(key: string, data: unknown): Promise<void> {
      await assertNotDeleted("document", key)
      await mkdir(rootPath, { recursive: true })
      const path = docPath(key)
      // Namespaced keys ("session-title/<id>") live in a subdirectory of the
      // store root — create it so nested doc keys work (top-level listings
      // stay clean: the subdir never matches `*.jsonl`).
      await mkdir(dirname(path), { recursive: true })
      // Atomic write: temp file + rename so concurrent saves never
      // interleave/truncate the sidecar. A transient `<uuid>.tmp` matches
      // neither `*.jsonl` nor `*.doc.jsonl`, so list() stays correct.
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(data) + "\n", { encoding: "utf-8" })
      await rename(tmp, path)
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      const text = await readFile(docPath(key), "utf-8").catch(() => undefined)
      if (text === undefined) return undefined
      return JSON.parse(text) as unknown
    },
    async deleteOwnedSession(sessionId, manifest) {
      if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) throw new Error("Invalid owned session identity")
      if (!Array.isArray(manifest.documents) || manifest.documents.length > 32 || new Set(manifest.documents).size !== manifest.documents.length) throw new Error("Invalid owned document manifest")
      const digest = createHash("sha256").update(sessionId).digest("hex")
      const owned = new Set([sessionId, `task-${sessionId}`, `session-title/${sessionId}`, `desktop-navigation-${digest}`, `desktop-session-project-${digest}`, `approval-history-${digest}`, `desktop-goal-${digest}`, `desktop-input-tokens-${digest}`])
      if (manifest.documents.some(key => !owned.has(key))) throw new Error("Document manifest includes an artifact not owned by this session")
      const files = [...(manifest.files ?? [])].sort()
      if (new Set(files).size !== files.length) throw new Error("Owned file manifest contains duplicate identities")
      if (files.length > 100000 || files.some(file => !new RegExp(`^rewind/${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:points\\.jsonl|meta\\.json|pending\\.json|orphaned\\.jsonl|blobs/[a-f0-9]{64})$`).test(file))) throw new Error("Invalid owned file manifest")
      const paths = [filePath(sessionId), ...manifest.documents.map(docPath), ...files.map(file => artifactPath(file, ""))]
      for (const path of paths) await confined(path)
      const marker = tombPath("session", sessionId)
      await confined(marker)
      const prior = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
      const header = prior === undefined ? await readHeader(filePath(sessionId)) : undefined
      if (header && header.sessionId !== sessionId) throw new Error("Owned session identity does not match artifact")
      const receipt = prior === undefined ? undefined : await deletionReceipt(sessionId)
      const visibility = header ? { ...(header.origin !== undefined ? { origin: header.origin } : {}), ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}) } : receipt?.visibility
      const document = JSON.stringify({ version: visibility ? 2 : 1, sessionId, ...(visibility ? { visibility } : {}), documents: [...manifest.documents].sort(), files })
      if (prior !== undefined && prior.trimEnd() !== document) throw new Error("Deletion artifact manifest changed")
      // A durable closure survives partial cleanup and prevents create/append/repair.
      if (prior === undefined) {
        await replaceSessionFile(marker, document, [])
      }
      for (const key of manifest.documents) {
        const path = tombPath("document", key)
        await confined(path)
        const handle = await open(path, "w")
        try { await handle.writeFile(sessionId); await handle.sync() } finally { await handle.close() }
      }
      for (const path of paths) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
    },
  }
}

// C5 header-only read (profile on a large artifact): the header is always
// line 0 and bounded (ids ~40 chars, titles capped at 200), so reading one
// 64 KiB window never touches the event body of a multi-megabyte log.
const HEADER_READ_MAX_BYTES = 64 * 1024

async function readHeader(path: string): Promise<SessionMeta> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(HEADER_READ_MAX_BYTES)
    await handle.read(buffer, 0, HEADER_READ_MAX_BYTES, 0)
    // Unread tail is zeros, so a newline found anywhere was inside the window.
    const end = buffer.indexOf(0x0a, 0) // "\n"
    const line = (end === -1 ? buffer : buffer.subarray(0, end)).toString("utf8")
    return parseHeader(line)
  } finally {
    await handle.close()
  }
}

// Track turn/step nesting; a session stopped inside either gets synthetic
// closers so deriveMessages() reconstructs normally (F01-2 commitRepair).
function missingClosers(events: SessionEvent[]): SessionEvent[] {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: SessionEvent[] = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
