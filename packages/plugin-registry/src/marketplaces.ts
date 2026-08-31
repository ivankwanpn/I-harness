/**
 * Marketplace collection and manifest parsing (4 source forms).
 *
 * A "market source" is where a plugin marketplace lives — one of:
 *   1. local directory            (existsSync + isDirectory → read in place)
 *   2. http(s) URL                (fetch marketplace.json → write to cacheDir)
 *   3. `owner/repo` shape         (expanded to the GitHub git URL)
 *   4. git URL                    (git clone --depth 1 → cacheDir)
 *
 * Notes:
 *   - Plugin code is never executed here; only JSON is parsed and files/URLs
 *     are read. Clones are plain directory copies.
 *   - Detection order is fixed by the spec: local dir first (existence wins
 *     over shape — a real directory named "owner/repo" beats the GitHub
 *     interpretation, which is what a user with such a directory expects).
 *   - Each cache-backed source (2-4) maps to a deterministic cache dir name
 *     under the caller's cacheDir; a repeated fetch re-pulls (the cached
 *     directory is removed before clone/download), never serving stale data.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Fetch timeout for the http(s) source form. */
const HTTP_FETCH_TIMEOUT_MS = 15_000

/** Kill a git clone that hangs (no credential prompt — non-interactive). */
const GIT_CLONE_TIMEOUT_MS = 60_000

/** An object-form plugin source (opencode's PluginSource contract). The
 * official Claude marketplace uses the git-subdir/url forms; the rest are
 * accepted for ecosystem parity. Optional pins (`ref`/`sha`) are honored at
 * clone time. */
export interface PluginSourceGitSubdir {
  source: "git-subdir"
  url: string
  path: string
  ref?: string
  sha?: string
}
export interface PluginSourceUrl {
  source: "url"
  url: string
  sha?: string
}
export interface PluginSourceGithub {
  source: "github"
  repo: string
  path?: string
}
export interface PluginSourceGit {
  source: "git"
  url: string
  ref?: string
  sha?: string
}
export interface PluginSourceDirectory {
  source: "directory"
  path: string
}
export interface PluginSourceFile {
  source: "file"
  path: string
}

/** A marketplace manifest entry's source: the ecosystem default string form
 * (`./plugins/<name>`-style, resolved against the marketplace dir) or an
 * object form carrying a remote clone (git-subdir/url/github/git) or a local
 * path (directory/file) — bug fix 1: object sources were parsed only as
 * strings, so a real object degraded to the `./plugins/<name>` default. */
export type PluginSource =
  | string
  | PluginSourceGitSubdir
  | PluginSourceUrl
  | PluginSourceGithub
  | PluginSourceGit
  | PluginSourceDirectory
  | PluginSourceFile

/** One plugin entry in a marketplace manifest. Only `name` is required by
 * the manifest; `source` is the plugin package location (relative to the
 * marketplace root for the string/directory/file forms), defaulting to
 * `./plugins/<name>` when absent (the Claude ecosystem default). */
export interface MarketplaceEntry {
  name: string
  description?: string
  version?: string
  category?: string
  tags?: string[]
  source: PluginSource
}

/** The parsed marketplace manifest (minimal field set). */
export interface MarketplaceManifest {
  name: string
  plugins: MarketplaceEntry[]
}

/** Error codes follow the packages/workspace convention: a `code` field the
 * host maps to HTTP statuses without string matching.
 *   - source-unreachable: the source could not be reached at all (bad URL,
 *     HTTP error status, connection refused, git clone failure).
 *   - manifest-invalid: the source was reached but no valid marketplace
 *     manifest was found (bad JSON, missing/empty name or plugins, no
 *     manifest file in the directory). */
export class MarketplaceFetchError extends Error {
  readonly code: "source-unreachable" | "manifest-invalid"
  constructor(message: string, code: "source-unreachable" | "manifest-invalid") {
    super(message)
    this.name = "MarketplaceFetchError"
    this.code = code
  }
}

/** Manifest file names, tried in this order inside a source directory. */
const MANIFEST_PATH_DOT = [".claude-plugin", "marketplace.json"]
const MANIFEST_PATH_BARE = ["marketplace.json"]

/**
 * Read the manifest text from a source directory, trying
 * `.claude-plugin/marketplace.json` first, then `marketplace.json`.
 * No manifest → manifest-invalid (the source was reachable, it just is not
 * a marketplace).
 */
function readManifestText(sourceDir: string): string {
  for (const segments of [MANIFEST_PATH_DOT, MANIFEST_PATH_BARE]) {
    try {
      return readFileSync(join(sourceDir, ...segments), "utf8")
    } catch {
      // try the next candidate
    }
  }
  throw new MarketplaceFetchError(
    `no marketplace manifest found in ${sourceDir} (looked for .claude-plugin/marketplace.json, then marketplace.json)`,
    "manifest-invalid",
  )
}

function failInvalid(message: string): never {
  throw new MarketplaceFetchError(message, "manifest-invalid")
}

function requireStringField(
  e: Record<string, unknown>,
  field: string,
  name: string,
  sourceDir: string,
): string {
  const v = e[field]
  if (typeof v !== "string" || v.trim() === "") {
    failInvalid(`marketplace manifest plugin '${name}': source field '${field}' must be a non-empty string (${sourceDir})`)
  }
  return (v as string).trim()
}

function optionalStringField(e: Record<string, unknown>, field: string): string | undefined {
  const v = e[field]
  return typeof v === "string" && v.trim() !== "" ? (v as string).trim() : undefined
}

/** `owner/repo` GitHub shape (same rule as the marketplace source's
 * `owner/repo` form; `path` is the subdir inside the cloned repo). */
const OWNER_REPO_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

/**
 * Expand a `github` plugin-source repo to the GitHub git URL — the same
 * expansion the marketplace `owner/repo` source form uses. Malformed (not
 * `owner/repo`, or a `.`/`..` part) → manifest-invalid.
 */
export function githubGitUrl(repo: string): string {
  const m = OWNER_REPO_RE.exec(repo)
  if (m === null) {
    failInvalid(`github plugin source repo ${JSON.stringify(repo)} must be an "owner/repo" shape`)
  }
  const [owner, name] = [m[1]!, m[2]!]
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    failInvalid(`github plugin source repo ${JSON.stringify(repo)} must be an "owner/repo" shape`)
  }
  return `https://github.com/${owner}/${name.replace(/\.git$/i, "")}.git`
}

/** Parse one source value: a string passes through trimmed (the ecosystem
 * default form; blank → marketplace default `./plugins/<name>`), an object is
 * shape-validated against the opencode PluginSource contract (bug fix 1),
 * absent/null → the marketplace default (behavior kept), any other junk
 * (number/boolean/array) → manifest-invalid. */
function parsePluginSource(value: unknown, name: string, sourceDir: string): PluginSource {
  if (typeof value === "string") return value.trim() === "" ? `./plugins/${name}` : value.trim()
  if (value === undefined || value === null) return `./plugins/${name}`
  if (typeof value !== "object" || Array.isArray(value)) {
    failInvalid(
      `marketplace manifest plugin '${name}': source must be a string or a source object (${sourceDir})`,
    )
  }
  const e = value as Record<string, unknown>
  const tag = e.source
  switch (tag) {
    case "git-subdir":
      return {
        source: "git-subdir",
        url: requireStringField(e, "url", name, sourceDir),
        path: requireStringField(e, "path", name, sourceDir),
        ...(optionalStringField(e, "ref") !== undefined ? { ref: optionalStringField(e, "ref")! } : {}),
        ...(optionalStringField(e, "sha") !== undefined ? { sha: optionalStringField(e, "sha")! } : {}),
      }
    case "url":
      return {
        source: "url",
        url: requireStringField(e, "url", name, sourceDir),
        ...(optionalStringField(e, "sha") !== undefined ? { sha: optionalStringField(e, "sha")! } : {}),
      }
    case "github": {
      const repo = requireStringField(e, "repo", name, sourceDir)
      if (!OWNER_REPO_RE.test(repo) || repo === "." || repo === "..") {
        failInvalid(
          `marketplace manifest plugin '${name}': github source repo must be an "owner/repo" shape (${sourceDir})`,
        )
      }
      return {
        source: "github",
        repo,
        ...(optionalStringField(e, "path") !== undefined ? { path: optionalStringField(e, "path")! } : {}),
      }
    }
    case "git":
      return {
        source: "git",
        url: requireStringField(e, "url", name, sourceDir),
        ...(optionalStringField(e, "ref") !== undefined ? { ref: optionalStringField(e, "ref")! } : {}),
        ...(optionalStringField(e, "sha") !== undefined ? { sha: optionalStringField(e, "sha")! } : {}),
      }
    case "directory":
      return { source: "directory", path: requireStringField(e, "path", name, sourceDir) }
    case "file":
      return { source: "file", path: requireStringField(e, "path", name, sourceDir) }
    default:
      failInvalid(`marketplace manifest plugin '${name}': unknown source ${JSON.stringify(tag)} (${sourceDir})`)
  }
}

function parseEntry(value: unknown, index: number, sourceDir: string): MarketplaceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failInvalid(`marketplace manifest plugin entry at index ${index} must be an object (${sourceDir})`)
  }
  const e = value as Record<string, unknown>
  if (typeof e.name !== "string" || e.name.trim() === "") {
    failInvalid(`marketplace manifest plugin entry at index ${index} is missing the required 'name' (${sourceDir})`)
  }
  const name = e.name.trim()
  const entry: MarketplaceEntry = {
    name,
    source: parsePluginSource(e.source, name, sourceDir),
  }
  for (const field of ["description", "version", "category"] as const) {
    const v = e[field]
    if (v === undefined) continue
    if (typeof v !== "string") {
      failInvalid(`marketplace manifest plugin entry '${name}': field '${field}' must be a string (${sourceDir})`)
    }
    entry[field] = v
  }
  if (e.tags !== undefined) {
    if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === "string")) {
      failInvalid(`marketplace manifest plugin entry '${name}': field 'tags' must be an array of strings (${sourceDir})`)
    }
    entry.tags = [...e.tags]
  }
  return entry
}

/**
 * Parse a marketplace manifest (minimal field set).
 *
 * `text` is the raw manifest JSON; pass "" to load it from disk at `sourceDir`
 * instead (`.claude-plugin/marketplace.json`, then `marketplace.json`).
 * `sourceDir` anchors error messages and is the base dir relative entry
 * `source` paths are resolved against by callers.
 *
 * Required: `name` (non-blank string) and `plugins` (non-empty array); each
 * entry requires a non-blank `name`. All other fields are optional:
 * description/version/category strings, tags array of strings, and `source`
 * (defaults to `./plugins/<name>`, the Claude ecosystem default).
 */
export function parseManifest(text: string, sourceDir: string): MarketplaceManifest {
  const raw = text.trim() === "" ? readManifestText(sourceDir) : text
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    failInvalid(`marketplace manifest is not valid JSON (${sourceDir})`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failInvalid(`marketplace manifest must be a JSON object (${sourceDir})`)
  }
  const m = parsed as Record<string, unknown>
  if (typeof m.name !== "string" || m.name.trim() === "") {
    failInvalid(`marketplace manifest is missing the required 'name' field (${sourceDir})`)
  }
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) {
    failInvalid(`marketplace manifest is missing the required non-empty 'plugins' array (${sourceDir})`)
  }
  return {
    name: m.name.trim(),
    plugins: m.plugins.map((p, i) => parseEntry(p, i, sourceDir)),
  }
}

function isLocalDirectory(source: string): boolean {
  try {
    return existsSync(source) && statSync(source).isDirectory()
  } catch {
    return false
  }
}

/** `owner/repo` shape: exactly one slash, and neither part path-ish (no "." /
 * "..", which belong to the local-path form). */
function isOwnerRepoShape(source: string): boolean {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(source)
  if (m === null) return false
  const [owner, repo] = [m[1]!, m[2]!]
  return owner !== "." && owner !== ".." && repo !== "." && repo !== ".."
}

function sanitizeName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.toLowerCase() || "source"
}

/**
 * Deterministic cache-directory name for a cache-backed source (http/owner/git
 * forms; local dirs use their basename but never cache).
 *
 * The `owner/repo` form is normalized to its expanded GitHub git URL BEFORE
 * sanitization — the exact string fetchSource passes onward — so fetch and
 * purge (the registry removes a source's cache dir by the stored source
 * string) always derive one shared key.
 */
export function cacheNameForSource(source: string): string {
  const trimmed = source.trim()
  const s = isOwnerRepoShape(trimmed) ? ownerRepoToGitUrl(trimmed) : trimmed
  let u: URL | null = null
  try {
    u = new URL(s)
  } catch {
    // not an absolute URL — fall through to the path-based forms
  }
  if (u !== null) {
    if (u.protocol === "file:") return sanitizeName(basename(u.pathname))
    const host = u.hostname + (u.port !== "" ? `-${u.port}` : "")
    const pathPart = u.pathname
      .split("/")
      .filter(Boolean)
      .join("-")
      .replace(/\.git$/i, "")
    return sanitizeName(`${host}-${pathPart}`)
  }
  const last = s.split("/").pop() ?? s
  return sanitizeName(last.replace(/\.git$/i, ""))
}

function ownerRepoToGitUrl(source: string): string {
  const [owner, repo] = source.split("/")
  return `https://github.com/${owner}/${repo!.replace(/\.git$/i, "")}.git`
}

async function fetchLocal(source: string): Promise<{ manifestDir: string; manifest: MarketplaceManifest }> {
  const manifestDir = resolve(source)
  return { manifestDir, manifest: parseManifest("", manifestDir) }
}

async function fetchHttp(source: string, cacheRoot: string): Promise<{ manifestDir: string; manifest: MarketplaceManifest }> {
  let res: Response
  try {
    res = await fetch(source, { signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS) })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new MarketplaceFetchError(`cannot reach marketplace URL ${source}: ${reason}`, "source-unreachable")
  }
  if (!res.ok) {
    throw new MarketplaceFetchError(`marketplace URL ${source} responded with HTTP ${res.status}`, "source-unreachable")
  }
  const text = await res.text()
  const dir = join(cacheRoot, cacheNameForSource(source))
  // Parse before writing: an invalid manifest leaves no partial cache entry.
  const manifest = parseManifest(text, dir)
  await mkdir(dir, { recursive: true })
  // Known trade-off (documented, deferred): the HTTP cache dir is not removed
  // before a re-pull (stale side files could linger) and the manifest write is
  // non-atomic (writeFile, not tmp+rename). Refinement is a later task.
  await writeFile(join(dir, ...MANIFEST_PATH_BARE), text, "utf8")
  return { manifestDir: dir, manifest }
}

async function fetchGit(url: string, cacheRoot: string): Promise<{ manifestDir: string; manifest: MarketplaceManifest }> {
  const dest = join(cacheRoot, cacheNameForSource(url))
  // Re-pull: cacheDir already holding this source is removed before cloning.
  await rm(dest, { recursive: true, force: true })
  await mkdir(cacheRoot, { recursive: true })
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--", url, dest], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new MarketplaceFetchError(`git clone failed for ${url}: ${reason}`, "source-unreachable")
  }
  return { manifestDir: dest, manifest: parseManifest("", dest) }
}

/**
 * Collect a marketplace source. Detection order (fixed): local directory →
 * http(s) URL → `owner/repo` (GitHub) → git URL. Returns the directory that
 * holds the manifest (the source dir, the clone root, or the download cache
 * dir) and the parsed manifest. A cache-backed source is always re-pulled;
 * never serves stale cached data.
 */
export async function fetchSource(
  source: string,
  cacheDir: string,
): Promise<{ manifestDir: string; manifest: MarketplaceManifest }> {
  const s = source.trim()
  if (isLocalDirectory(s)) return fetchLocal(s)
  if (/^https?:\/\//i.test(s)) return fetchHttp(s, resolve(cacheDir))
  if (isOwnerRepoShape(s)) return fetchGit(ownerRepoToGitUrl(s), resolve(cacheDir))
  return fetchGit(s, resolve(cacheDir))
}
