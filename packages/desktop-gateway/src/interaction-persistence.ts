import { createHash, randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { InteractionPersistence, PendingInteraction } from "./interaction.ts"

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 2048

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function validRow(value: unknown): value is PendingInteraction {
  if (!object(value) || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128
    || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256
    || (value.kind !== "question" && value.kind !== "approval") || !object(value.payload)
    || typeof value.openedAt !== "number" || !Number.isFinite(value.openedAt) || value.openedAt < 0
    || (value.expiresAt !== undefined && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt < value.openedAt))
    || (value.state !== undefined && value.state !== "interrupted")) return false
  return true
}

/** Workspace-scoped snapshots contain presentation data only. Atomic saves
 * happen before a live prompt is emitted or a consumed reply is acknowledged.
 * Synchronous mutations keep the bridge's existing live-reply ordering intact. */
export async function openInteractionPersistence(sessionDir: string, workspace: string): Promise<InteractionPersistence> {
  const scope = resolve(workspace).replaceAll("\\", "/")
  const canonical = process.platform === "win32" ? scope.toLowerCase() : scope
  const key = createHash("sha256").update(canonical).digest("hex")
  const path = join(sessionDir, `interaction-pending-${key}.json`)
  await mkdir(sessionDir, { recursive: true })
  let rows: PendingInteraction[] = []
  try {
    const raw = await readFile(path, "utf8")
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("snapshot exceeds size limit")
    const document: unknown = JSON.parse(raw)
    if (!object(document) || document.version !== 1 || document.workspace !== canonical || !Array.isArray(document.pending)
      || document.pending.length > MAX_ROWS || !document.pending.every(validRow)
      || new Set(document.pending.map((row) => row.requestId)).size !== document.pending.length) throw new Error("invalid snapshot")
    rows = document.pending
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not restore pending interactions: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    read: () => structuredClone(rows),
    write(next) {
      if (next.length > MAX_ROWS || !next.every(validRow)) throw new Error("Invalid pending interaction snapshot")
      const raw = JSON.stringify({ version: 1, workspace: canonical, pending: next })
      if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("Pending interaction snapshot exceeds size limit")
      const temporary = `${path}.tmp-${randomUUID()}`
      let fd: number | undefined
      try {
        mkdirSync(sessionDir, { recursive: true })
        fd = openSync(temporary, "wx", 0o600)
        writeFileSync(fd, raw, "utf8")
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        renameSync(temporary, path)
        rows = structuredClone(next)
      } finally {
        if (fd !== undefined) closeSync(fd)
        try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
    },
  }
}
