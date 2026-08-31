/**
 * Bounded workspace directory walk (task 5.4b — DSH `fileReferences.list`
 * parity simplified to OUR honest minimal). DSH's file-reference provider
 * answers deterministic path-only candidates for an Agent's working
 * directory; here the unit is a Workspace directory path and the interface
 * is one function over node:fs — no coordinator, no state, no socket.
 *
 * Caps (the walk must never be unbounded — a large repo is a keystroke-rate
 * surface):
 *  - maxEntries: candidate rows reported (default 500)
 *  - maxVisited: directory entries EXAMINED, the work bound (default 3000)
 *  - maxDepth: directory levels below the workspace root (default 8)
 * When a cap is hit the walk stops EARLY (frontier-abandoned) and only the
 * collected prefix is answered — honest, never a silent full scan.
 *
 * Skips: entries named `node_modules` / `.git` / `.i-harness` / `dist`
 * (exact names, any depth) and SYMLINKS entirely. Symlinks are skipped — not
 * followed — so a link cannot drag the walk outside the registered workspace
 * directory or loop (a link-to-dir inside the repo is still listed as a
 * candidate in DSH's fuzzier semantics; refusing to follow is the safe
 * minimal and documented here).
 *
 * Matching: case-insensitive substring against the workspace-relative path
 * (the `name` is a suffix of the path, so no second check). DSH matches are
 * fuzzier (ranked, segment-aware); a substring match with NO ranking is the
 * honest minimal — candidates are deterministic (codepoint sort per level,
 * files-and-dirs interleaved in discovery order).
 *
 * Candidate fields (DSH names kept): `path` (workspace-relative, "/"
 * separators on the wire on every platform), `name` (basename), plus `type`
 * ("file" | "dir") — a DELIBERATE additive extension: the picker draws a
 * per-type icon, and a path-only candidate cannot answer it.
 *
 * Root errors are LOUD: an unreadable/missing workspace root throws (the
 * registered directory vanished or is inaccessible — an empty result would
 * be a silent lie). Nested unreadable directories are skipped (the walk is
 * best-effort below the root; a nested permission error does not burn the
 * whole picker).
 */

import { readdir } from "node:fs/promises"
import { join, sep } from "node:path"

/** One discovered workspace entry (DSH fileReferences candidate, simplified). */
export interface FileReferenceCandidate {
  /** Workspace-relative path, always "/" separators. */
  path: string
  /** basename(path) — the display label. */
  name: string
  /** "file" | "dir" — the picker's per-row icon. Additive vs DSH path/name. */
  type: "file" | "dir"
}

export interface ListWorkspaceFilesOptions {
  /** Candidate rows answered; the walk stops early at this cap. Default 500. */
  maxEntries?: number
  /** Directory levels below the root examined; deeper levels never entered. Default 8. */
  maxDepth?: number
  /** Directory ENTRIES examined (the work bound). Default 3000. */
  maxVisited?: number
  /** Entries skipped by exact name (directories or files), any depth. */
  skipNames?: readonly string[]
}

export const DEFAULT_LIST_FILES_SKIP_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  ".i-harness",
  "dist",
]

export const DEFAULT_LIST_FILES_OPTIONS: Required<ListWorkspaceFilesOptions> = {
  maxEntries: 500,
  maxDepth: 8,
  maxVisited: 3000,
  skipNames: DEFAULT_LIST_FILES_SKIP_NAMES,
}

/**
 * Bounded, deterministic listing of the files+directories under `root`
 * (workspace-relative paths). `query` is the text following "@": same
 * substring semantics as the session meta search (case-insensitive, no
 * ranking); "" lists everything under the caps.
 * @param root - the workspace directory path on disk (the registry's
 *   `Workspace.path` — the caller resolves the id→path mapping).
 * @param query - optional case-insensitive path substring; "" = no filter.
 * @throws when the root itself is unreadable/missing (loud, never a silent
 *   empty result for a vanished workspace).
 */
export async function listWorkspaceFiles(
  root: string,
  query: string,
  options: ListWorkspaceFilesOptions = {},
): Promise<FileReferenceCandidate[]> {
  const opts: Required<ListWorkspaceFilesOptions> = {
    maxEntries: options.maxEntries ?? DEFAULT_LIST_FILES_OPTIONS.maxEntries,
    maxDepth: options.maxDepth ?? DEFAULT_LIST_FILES_OPTIONS.maxDepth,
    maxVisited: options.maxVisited ?? DEFAULT_LIST_FILES_OPTIONS.maxVisited,
    skipNames: options.skipNames ?? DEFAULT_LIST_FILES_OPTIONS.skipNames,
  }
  const needle = query.toLowerCase()
  const results: FileReferenceCandidate[] = []
  let visited = 0
  let exhausted = false

  async function walk(relDir: string, depth: number): Promise<void> {
    if (exhausted) return
    if (depth > opts.maxDepth) return
    let entries
    try {
      // readdir per directory level — bounded by maxVisited across the walk.
      entries = await readdir(join(root, relDir), { withFileTypes: true })
    } catch (error) {
      // The ROOT must answer or the whole answer is a silent lie; nested
      // unreadable directories (Windows ACLs, half-created trees) degrade
      // gracefully instead of killing the picker for that subtree.
      if (relDir === "") throw error
      return
    }
    // Deterministic order: codepoint sort (localeCompare is ICU-dependent,
    // not stable across machines — a picker must not reorder between hosts).
    const sorted = [...entries].sort((a, b): number =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of sorted) {
      if (exhausted) return
      if (visited >= opts.maxVisited) { exhausted = true; return }
      visited += 1
      if (opts.skipNames.includes(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const childName = entry.name
      const childPath = relDir === "" ? childName : `${relDir.replaceAll(sep, "/")}/${childName}`
      const type: FileReferenceCandidate["type"] | undefined = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : undefined
      if (type === undefined) continue // fifo/socket/device — not a reference target
      // The filter narrows the CANDIDATES, never the walk: a directory whose
      // own path does not match may still CONTAIN matches ("src" vs ?q=upper
      // still descends into src/lib/UPPER.TS).
      const matches = needle === "" || childPath.toLowerCase().includes(needle)
      if (matches) {
        if (results.length >= opts.maxEntries) { exhausted = true; return }
        results.push({ path: childPath, name: childName, type })
      }
      if (type === "dir" && depth < opts.maxDepth) {
        await walk(relDir === "" ? childName : `${relDir}${sep}${childName}`, depth + 1)
      }
    }
  }

  await walk("", 0)
  return results
}
