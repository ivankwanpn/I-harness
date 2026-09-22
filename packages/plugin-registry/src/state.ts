/**
 * Durable state for the plugin registry: one JSON document `<root>/state.json`.
 * Convention: plugin code is never executed by this package; the document is
 * plain data only. A missing or corrupt document is never fatal — it is
 * rebuilt from the default state and the problem is reported via console.warn.
 *
 * Both the async (loadState) and the sync (loadStateSync) variants validate
 * with the same deep-enough shape check: every source needs name/source/
 * lastUpdated and every plugin needs the full record field set. Anything that
 * does not fit — wrong version, wrong field types, garbage JSON, unreadable
 * file — is rebuilt as the default state (never thrown).
 */

import { mkdir, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { currentDiagnostics } from "@i-harness/diagnostics"
import { writeFileAtomic } from "@i-harness/fs"
import type { PluginSourceInfo, PluginRecord, PluginState } from "./types.ts"

const STATE_FILE_NAME = "state.json"

function defaultState(): PluginState {
  return { version: 1, sources: [], plugins: [] }
}

function isPluginSourceInfo(value: unknown): value is PluginSourceInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === "string" &&
    typeof v.source === "string" &&
    typeof v.lastUpdated === "number"
  )
}

function isCommandConflict(value: unknown): value is { name: string; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.name === "string" && typeof v.reason === "string"
}

function isPluginRecord(value: unknown): value is PluginRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.marketplace === "string" &&
    typeof v.name === "string" &&
    typeof v.installPath === "string" &&
    typeof v.installed === "boolean" &&
    typeof v.enabled === "boolean" &&
    (v.conflicts === undefined || (Array.isArray(v.conflicts) && v.conflicts.every(isCommandConflict)))
  )
}

function isPluginState(value: unknown): value is PluginState {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.version === 1 &&
    Array.isArray(v.sources) &&
    v.sources.every(isPluginSourceInfo) &&
    Array.isArray(v.plugins) &&
    v.plugins.every(isPluginRecord)
  )
}

// W6 T6: the state file's rebuild report — this is how the plugins SEAM
// announces that a corrupt/unshapeable document was replaced by the defaults,
// hence phase `mount`. The call reaches the ambient instance when a host
// installed one and is the console call it always was when none is: same
// function, same single verbatim argument.
function rebuilt(reason: string, file: string): PluginState {
  const message = `[plugin-registry] state file ${reason} (${file}); rebuilding defaults`
  const d = currentDiagnostics()
  if (d === undefined) console.warn(message)
  else d.child("mount").warn(message)
  return defaultState()
}

/** Load the registry state; missing/unreadable/corrupt → default + console.warn. */
export async function loadState(root: string): Promise<PluginState> {
  const file = join(root, STATE_FILE_NAME)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (!isPluginState(parsed)) return rebuilt("has an invalid shape", file)
    return parsed
  } catch {
    return rebuilt("is missing or unreadable", file)
  }
}

/**
 * Synchronous variant of loadState — PluginRegistry.runtimeInputs() is called
 * by the host on every agent build and cannot await. Same contract: missing /
 * unreadable / corrupt state → default state + console.warn, never thrown.
 */
export function loadStateSync(root: string): PluginState {
  const file = join(root, STATE_FILE_NAME)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isPluginState(parsed)) return rebuilt("has an invalid shape", file)
    return parsed
  } catch {
    return rebuilt("is missing or unreadable", file)
  }
}

/**
 * Persist the registry state atomically (tmp + rename, via @i-harness/fs).
 * The state directory is created with 0700 — on win32 the mode is best-effort
 * (Node ignores it; Windows ACLs apply instead).
 */
export async function saveState(root: string, state: PluginState): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFileAtomic(join(root, STATE_FILE_NAME), JSON.stringify(state, null, 2))
}
