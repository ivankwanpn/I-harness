import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path"
import { CURRENT_FORMAT_VERSION, isContextEventType, validContextEvent, validateConversationEventShape, validateConversationHistory, legacyPrefixDigest, readFactJournal, encodeFactBatch, type SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail } from "./format.ts"
import { replaceSessionFile, replaceRawSessionFile } from "./backend/session-io.ts"
import { createFactJournalBackend } from './backend/fact-journal.ts'
import { upgradeFactJournal } from './backend/format-upgrade.ts'

// C5 blank-probe cap (DSH coldBlankProbeMaxBytes parity, DSH default 1024): a
// session artifact at or under this size is read in full for the EXACT blank
// answer (no turn/start yet); a larger one is served non-blank without a read
// (honest-bounding: it may have content — never guessed blank).
const BLANK_PROBE_MAX_BYTES = 1024

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
    ...createFactJournalBackend(filePath, assertNotDeleted),
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    // M23: the coordinator's ownership lease defaults to the store root.
    lockRoot: root,
    deletionReceipt,

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      await assertNotDeleted("session", sessionId)
      if (meta.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("new session writers require current format; downgrade refused")
      await mkdir(rootPath, { recursive: true })
      // wx: fail if the session file already exists.
      const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const }
      await writeFile(filePath(sessionId), serializeHeader({ ...meta, journal }) + "\n", { flag: "wx" })
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const header = await readHeader(path)
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      for (const event of events) validateConversationEventShape(event, header.formatVersion)
      if (events.some(event => isContextEventType(event.type) && (header.formatVersion < 2 || !validContextEvent(event)))) throw new Error("operational context append requires format 2 and valid facts")
      const handle = await open(path, "r+")
      let committedBytes = 0
      try {
        committedBytes = (await handle.stat()).size
        const lastByte = Buffer.alloc(1)
        if (committedBytes > 0) await handle.read(lastByte, 0, 1, committedBytes - 1)
        const separator = events.length > 0 && committedBytes > 0 && lastByte[0] !== 0x0a ? "\n" : ""
        const data = [6, 7].includes(header.formatVersion)
          ? (() => {
            const raw = readFile(path)
            return raw.then(bytes => {
              const end = bytes.indexOf(0x0a), journal = readFactJournal(bytes.subarray(end + 1), header.journal!, header.formatVersion)
              if (journal.torn) throw new Error('Journal recovery required')
              const addressed = events.map((event, position) => event.seq === undefined ? { ...event, seq: journal.prefix.eventCount + position } : event)
              return addressed.length ? encodeFactBatch(randomUUID(), journal.prefix.prefixDigest, addressed).bytes : new Uint8Array()
            })
          })()
          : Promise.resolve(Buffer.from(separator + events.map((e) => JSON.stringify(e)).join("\n") + "\n"))
        const bytes = await data
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, committedBytes + offset)
          if (bytesWritten <= 0) throw new Error('Session write made no progress')
          offset += bytesWritten
        }
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
      const events = [6, 7].includes(header.formatVersion) ? readFactJournal(Buffer.from(lines.slice(1).join('\n')), header.journal!, header.formatVersion).events : parseEventLines(lines.slice(1))
      if (![6, 7].includes(header.formatVersion) && events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion)
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
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      if ([6, 7].includes(header.formatVersion)) {
        const decoded = readFactJournal(Buffer.from(lines.slice(1).join('\n')), header.journal!, header.formatVersion)
        const closers = missingClosers(decoded.events).map((event, position) => ({ ...event, seq: decoded.events.length + position }))
        if (decoded.torn || closers.length) {
          const raw = Buffer.from(lines.slice(1).join('\n')).subarray(0, decoded.prefix.bodyBytes)
          const addition = closers.length ? encodeFactBatch(randomUUID(), decoded.prefix.prefixDigest, closers).bytes : new Uint8Array()
          await replaceRawSessionFile(path, Buffer.concat([Buffer.from(headerLine + '\n'), raw, Buffer.from(addition)]))
        }
        return { version: header.formatVersion, events: [...decoded.events, ...closers], meta: header }
      }
      const events = parseEventLines(lines.slice(1))
      if (events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion)
      const torn = hasTornTail(lines.slice(1))
      const closers = missingClosers(events)
      if (events.some(event => event.type === "conversation/semantics")) {
        for (const [index, event] of closers.entries()) event.seq = events.length + index
        if (torn || closers.length) {
          let committed = lines[0]! + "\n"
          for (const line of lines.slice(1)) {
            if (line.trim()) { try { JSON.parse(line) } catch { break } }
            committed += line + "\n"
          }
          // Preserve every existing committed line, including whitespace. Only
          // the torn suffix is removed; repair facts get new coordinates.
          await replaceRawSessionFile(path, committed + closers.map(event => JSON.stringify(event) + "\n").join(""))
        }
        return { version: header.formatVersion, events: [...events, ...closers], meta: header }
      }
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
      const header = parseHeader(headerLine)
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      if (events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion)
      if ([6, 7].includes(header.formatVersion)) {
        const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const }
        const frame = events.length ? encodeFactBatch(randomUUID(), journal.legacyPrefixDigest, events).bytes : new Uint8Array()
        await replaceRawSessionFile(path, Buffer.concat([Buffer.from(serializeHeader({ ...header, journal }) + '\n'), Buffer.from(frame)]))
        return
      }
      await replaceSessionFile(path, headerLine, events)
    },

    async upgradeSessionFormat(sessionId, expected, target) {
      await assertNotDeleted("session", sessionId)
      if (target !== CURRENT_FORMAT_VERSION || ![1, 2, 3, 4, 5, 6, target].includes(expected)) throw new Error("unexpected session format upgrade or downgrade")
      const path = filePath(sessionId)
      return upgradeFactJournal(path, expected)
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
          blank: ([6, 7].includes(parseHeader(lines[0]!).formatVersion)
            ? readFactJournal(Buffer.from(lines.slice(1).join('\n')), parseHeader(lines[0]!).journal!, parseHeader(lines[0]!).formatVersion).events
            : parseEventLines(lines.slice(1))).every((ev) => ev.type !== "turn/start"), updatedAt,
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
      const previous = parseHeader(lines[0]!)
      if (Object.hasOwn(patch, 'journal') && JSON.stringify(patch.journal) !== JSON.stringify(previous.journal)) throw new Error('Journal metadata changes require fenced recovery')
      if (Object.hasOwn(patch, "formatVersion") && patch.formatVersion !== previous.formatVersion) throw new Error("format changes require durable upgrade; downgrade refused")
      const merged: SessionMeta = { ...previous, ...patch }
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
function missingClosers(events: SessionEvent[]): Array<Extract<SessionEvent, { type: 'step/end' | 'turn/end' }>> {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: Array<Extract<SessionEvent, { type: 'step/end' | 'turn/end' }>> = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
