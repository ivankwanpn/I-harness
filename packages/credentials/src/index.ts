/**
 * Durable credential refs for I-harness (dsh §settings credentials per source).
 *
 * One JSON document under the user's config home, separate from settings.json:
 * the settings document must NEVER hold key material — it only references a
 * credential ref by name (`apiKeyEnv`). Read precedence is
 * `process.env > file`: a ref whose name is present as an environment variable
 * with a NON-EMPTY value is satisfied by the env (source "env") and any file
 * write for it is rejected as env-shadowed. The env var name IS the ref (refs
 * are env-grammar identifiers).
 *
 * Empty-value stance (both sides, self-consistent): a value with no non-
 * whitespace characters means "not configured here" — empty file entries are
 * dropped on load and an empty env var does not shadow the file, so
 * `{configured:false}` is what an empty secret reliably reports.
 *
 * Failure stance (settings/plugin-state spirit): reads are non-fatal — a
 * missing file is a normal first run, so it degrades to an empty refs map
 * silently; a corrupt/unshapeable document (bad JSON, non-object root,
 * non-string or empty entries) also degrades to empty, but reports via
 * console.warn. Writes are atomic (tmp + rename via @i-harness/fs, tmp
 * created 0600 so the temp window never carries the secret looser) plus an
 * extra best-effort chmod 0600 — on win32 chmod is best-effort (Node ignores
 * POSIX mode bits; Windows ACLs apply instead), same stance as plugin state.
 *
 * @module @i-harness/credentials
 */

import { chmodSync, readFileSync } from "node:fs"
import { writeFileAtomic } from "@i-harness/fs"

/** Source of a configured value; "file" is also the projected write target
 * of an unconfigured ref (a future write would land in the file). */
export type CredentialSource = "env" | "file"

/** One-way describe record — never carries the value itself. */
export interface CredentialInfo {
  configured: boolean
  source: CredentialSource
  /** false when the ref is env-shadowed (a file write would never take effect). */
  writable: boolean
}

/** The write-time document shape: a single `refs` map. */
export interface CredentialDocument {
  refs: Record<string, string>
}

/**
 * Invalid ref name or raw set value → code "credential-invalid-ref".
 */
export class CredentialRefError extends Error {
  readonly code = "credential-invalid-ref"
  constructor(message: string) {
    super(message)
    this.name = "CredentialRefError"
  }
}

/**
 * A write (set/unset) on a ref already provided by the environment → code
 * "credential-rejected". Silent shadowed writes would make the user believe
 * the file value took effect; reject instead.
 */
export class CredentialShadowedError extends Error {
  readonly code = "credential-rejected"
  constructor(message: string) {
    super(message)
    this.name = "CredentialShadowedError"
  }
}

/** `refs` grammar: a valid environment-variable name (env vars ARE the refs). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Create a credential store over one document.
 *
 * `describe` is synchronous (one-way redacted snapshot — read loads the small
 * document synchronously); `set`/`unset` are async (atomic write). `resolve`
 * is the INTERNAL read chain (review r1): env (non-empty) > file, returning
 * the VALUE to the application's build path (model clients) — it is NOT part
 * of the one-way surface (never echo a value through describe; resolve hands
 * it to a builder, never to a UI-facing reader).
 *
 * @param documentPath - where the refs map lives (e.g. `~/.i-harness/credentials.json`).
 */
export function createCredentialStore(documentPath: string): {
  describe(refs: string[]): Record<string, CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  /** Non-echoing read chain: env (non-empty) > file; undefined when absent. */
  resolve(ref: string): string | undefined
} {
  return {
    describe(refs) {
      for (const ref of refs) validateRef(ref)
      const file = loadRefsSync(documentPath)
      const out: Record<string, CredentialInfo> = {}
      for (const ref of refs) {
        if (envProvides(ref)) out[ref] = { configured: true, source: "env", writable: false }
        else if (ref in file) out[ref] = { configured: true, source: "file", writable: true }
        else out[ref] = { configured: false, source: "file", writable: true }
      }
      return out
    },
    async set(ref, value) {
      validateRef(ref)
      validateValue(value)
      throwIfEnvShadowed(ref)
      const refs = loadRefsSync(documentPath)
      refs[ref] = value
      await persistRefs(documentPath, refs)
    },
    async unset(ref) {
      validateRef(ref)
      throwIfEnvShadowed(ref)
      const refs = loadRefsSync(documentPath)
      if (!(ref in refs)) return // already absent → idempotent no-op
      delete refs[ref]
      await persistRefs(documentPath, refs)
    },
    resolve(ref) {
      validateRef(ref)
      if (envProvides(ref)) return process.env[ref]
      return loadRefsSync(documentPath)[ref]
    },
  }
}

function validateRef(ref: unknown): asserts ref is string {
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new CredentialRefError(
      `invalid credential ref ${JSON.stringify(ref)}: must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    )
  }
}

/** Writes reject empty/whitespace values; the loader drops them on read too,
 * so an empty value is never representable — the ref simply reports unset. */
function validateValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CredentialRefError("invalid credential value: expected a non-empty string")
  }
}

/** Env shadows the file only with a non-empty value (empty/whitespace means
 * "not configured here" — same stance as the loader dropping empty entries). */
function envProvides(ref: string): boolean {
  const value = process.env[ref]
  return value !== undefined && value.trim() !== ""
}

function throwIfEnvShadowed(ref: string): void {
  if (envProvides(ref)) {
    throw new CredentialShadowedError(
      `credential ref ${ref} is provided by the environment variable ${ref}; a file write would never take effect`,
    )
  }
}

/** Synchronous load with the degrade-to-empty stance from the module doc. */
function loadRefsSync(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnBad(path, "root is not an object")
      return {}
    }
    const rawRefs = (parsed as Record<string, unknown>).refs
    if (rawRefs === undefined) return {}
    if (typeof rawRefs !== "object" || rawRefs === null || Array.isArray(rawRefs)) {
      warnBad(path, "refs is not an object")
      return {}
    }
    const refs: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawRefs as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim() !== "") refs[key] = value
      else warnBad(path, `dropping entry for ref ${key} (empty or non-string)`)
    }
    return refs
  } catch (err) {
    // ENOENT = normal first run → empty, silent. Anything else (corrupt JSON,
    // unreadable) → empty + warn, never throw.
    if (isEnoent(err)) return {}
    warnBad(path, "unreadable or corrupt")
    return {}
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT"
}

function warnBad(path: string, reason: string): void {
  console.warn(`[credentials] credential file ${path} ${reason}; treating as empty`)
}

/** Atomic write + 0600 (mode best-effort on win32; see module doc). The fs
 * mode param creates the temp 0600 so the leftover-window tmp and the renamed
 * file are never world-readable; chmodSync after is a defensive normalize for
 * pre-existing files written before this round. */
async function persistRefs(path: string, refs: Record<string, string>): Promise<void> {
  const doc: CredentialDocument = { refs }
  await writeFileAtomic(path, JSON.stringify(doc, null, 2), 0o600)
  try {
    chmodSync(path, 0o600)
  } catch {
    // win32: Node ignores POSIX mode bits; Windows ACLs apply instead.
  }
}
