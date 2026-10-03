import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { RewindStore } from "@i-harness/rewind"
import type { SessionArtifactManifest } from "@i-harness/session-persistence"
import { desktopInputReceiptDocumentKey } from "./input.ts"

/** Producer-owned keys only; global credentials/memory/workspace files are not artifacts. */
export function sessionOwnedDocuments(id: string): string[] {
  const digest = createHash("sha256").update(id).digest("hex")
  return [id, `task-${id}`, `session-title/${id}`, `desktop-navigation-${digest}`, `desktop-session-project-${digest}`, `approval-history-${digest}`, `desktop-goal-${digest}`, desktopInputReceiptDocumentKey(id)]
}
export async function sessionArtifactManifest(sessionDir: string, workspace: string, id: string): Promise<SessionArtifactManifest> {
  if (!id || /[\\/]/.test(id) || id.includes("..")) throw new Error("Invalid session artifact identity")
  const prefix = `rewind/${id}`
  for (const path of [sessionDir, join(sessionDir, "rewind"), join(sessionDir, prefix), join(sessionDir, prefix, "blobs")]) {
    const row = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (row?.isSymbolicLink()) throw new Error("Session artifact directory is a symlink")
  }
  const rewind = new RewindStore({ root: sessionDir, workspace, sessionId: id })
  await rewind.assertWorkspace(workspace)
  if (await rewind.readUnresolvedPending()) throw new Error("Session has a pending rewind recording")
  const names = await readdir(join(sessionDir, prefix, "blobs")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error })
  // Blob names are validated store identities, not a session filename prefix.
  const files = ["points.jsonl", "meta.json", "pending.json", "orphaned.jsonl"].map(name => `${prefix}/${name}`)
  files.push(...names.filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => `${prefix}/blobs/${name}`))
  return { documents: sessionOwnedDocuments(id), files }
}
