import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { CURRENT_FORMAT_VERSION, readFactJournal, validJournalMetadata, validateConversationHistory, type SessionEvent } from "@i-harness/core-session"
import { observeFailed, type HeaderMeta, type SnapshotRow } from "./contracts.ts"

// Read-only mirrors of the JSONL format; source bytes are never repaired.
function parseHeader(line: string): HeaderMeta {
  const h = JSON.parse(line) as Record<string, unknown>
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  if (h.formatVersion > CURRENT_FORMAT_VERSION) throw new Error(`format version ${h.formatVersion} is newer than this build (upgrade the harness)`)
  if ([6, 7, 8, 9].includes(h.formatVersion) && !validJournalMetadata(h.journal)) throw new Error('invalid managed journal metadata')
  return {
    formatVersion: h.formatVersion,
    sessionId: h.sessionId,
    createdAt: typeof h.createdAt === "string" ? h.createdAt : "",
    ...(typeof h.parentSession === "string" ? { parentSession: h.parentSession } : {}),
    ...(typeof h.seedLength === "number" ? { seedLength: h.seedLength } : {}),
    ...(typeof h.delegationDepth === "number" ? { delegationDepth: h.delegationDepth } : {}),
    ...(typeof h.origin === "string" ? { origin: h.origin } : {}),
    ...([6, 7, 8, 9].includes(h.formatVersion) ? { journal: h.journal as import('@i-harness/core-session').JournalMetadata } : {}),
  }
}

/** Structural history prefix up to the first torn record (F01-2).
 * Returns the raw valid lines too (header + event lines) for the fingerprint
 * and exact format6 bytes. Bare file observation is not fsync/receipt proof. */
export function parseLinePrefix(input: string | Uint8Array): { header: HeaderMeta; events: SessionEvent[]; contentLines: string[]; contentBytes?: Uint8Array } {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  const text = bytes.toString('utf8')
  const lines = text.split("\n")
  if (lines.length === 0 || lines[0]!.trim() === "") throw new Error("empty session file")
  const header = parseHeader(lines[0]!)
  if ([6, 7, 8, 9].includes(header.formatVersion)) {
    const end = bytes.indexOf(0x0a)
    if (end < 0) throw new Error('incomplete managed session header')
    const journal = readFactJournal(bytes.subarray(end + 1), header.journal!, header.formatVersion, header)
    const contentBytes = bytes.subarray(0, end + 1 + journal.prefix.bodyBytes)
    return { header, events: journal.events, contentLines: contentBytes.toString().trimEnd().split('\n'), contentBytes }
  }
  const events: SessionEvent[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === "") continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch {
      break // torn tail — preserve the existing legacy structural prefix
    }
  }
  if (events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion)
  return { header, events, contentLines: [lines[0]!, ...lines.slice(1, 1 + events.length)] }
}

export function revisionOf(st: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.size}:${Math.round(st.mtimeMs * 1e6)}:${Math.round(st.ctimeMs * 1e6)}`
}

export function createStoreScanner(storeRoot: string, signalGuard: () => void): () => Promise<Map<string, SnapshotRow>> {
  async function scanStore(): Promise<Map<string, SnapshotRow>> {
    signalGuard()
    const names = await readdir(storeRoot).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[] // store not created yet → empty
      throw observeFailed(`scan ${storeRoot}`, err)
    })
    const snapshots = new Map<string, SnapshotRow>()
    for (const name of names) {
      signalGuard()
      if (!name.endsWith(".jsonl") || name.endsWith(".doc.jsonl")) continue
      const id = name.slice(0, -".jsonl".length)
      const file = join(storeRoot, name)
      let st
      try {
        st = await stat(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue // deleted between readdir and stat
        throw observeFailed(`stat ${file}`, err)
      }
      if (st.size === 0) continue // header not yet written — next round picks it up
      snapshots.set(id, { revision: revisionOf(st), file })
    }
    return snapshots
  }

  return scanStore
}
