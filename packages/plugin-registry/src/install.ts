/**
 * Plugin installation (atomic) and un-installation.
 *
 * `installPlugin` copies a plugin package directory into
 * `<installRoot>/<mkt>__<name>` via a temp directory INSIDE installRoot followed
 * by an atomic rename — so no half-installed plugin is ever observable at the
 * install path. Overwrites are two-phase: the existing copy is first parked to
 * `.id.old-<uuid>`, the staged copy is renamed into place, then the parked copy
 * is dropped. An interruption at any point leaves either the old or the new
 * copy plainly present on disk (at the install path or parked/staged next to
 * it) — never nothing; a failed swap restores the parked old copy. Leftover
 * `.id.old-*` / `.id.tmp-*` artifacts of a crash are cleaned on the next
 * install. The installed copy of `.mcp.json` is rewritten with server names
 * re-keyed as `plugin:<mkt>__<name>:<server>` (both parts sanitized by
 * `mcpServerKey` — a marketplace display name with a space, e.g.
 * "Marketplace A", yields `plugin:Marketplace_A__…`) so the runtime host
 * consumes one namespaced Record<string, MCP_CONFIG_SHAPE> merged across
 * plugins (readable back via `readMcpServers`).
 *
 * Entry-source 約束 (carried from the Task 2 review): a marketplace manifest
 * entry's `source` is resolved via `resolveEntrySource` and must stay inside
 * the marketplace's own directory — checked twice, lexically (path traversal
 * `../…`, absolute paths outside the marketplace) and against realpaths (an
 * in-marketplace symlink whose target lives outside is rejected; git preserves
 * symlinks, local-dir marketplaces alike). The copy dereferences symlinks, so
 * an installed plugin is a plain file tree and no entry inside installRoot is
 * ever a link whose live content escapes it.
 *
 * Plugin code is never executed here: an install is a plain file copy, and
 * package.json / .mcp.json are only JSON.parsed (never imported/required).
 *
 * Error codes (same convention as the rest of the package — a `code` field the
 * host maps to HTTP statuses without string matching):
 *   - plugin-invalid: the plugin package itself is unusable (missing source
 *     dir, malformed .mcp.json, malformed id).
 *   - install-failed: an unexpected filesystem failure during copy/rename.
 */

import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, realpathSync, readFileSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { inspectCapabilities, type Capabilities } from "./capability.ts"
import { githubGitUrl, MarketplaceFetchError, type PluginSource } from "./marketplaces.ts"
import type { MCP_CONFIG_SHAPE } from "./types.ts"

const execFileAsync = promisify(execFile)

/** Kill a hanging plugin clone (no credential prompt — non-interactive). */
const GIT_PLUGIN_CLONE_TIMEOUT_MS = 60_000

/** Characters that are path-hostile in a single path component on win32/posix. */
const PATH_HOSTILE_RE = /[\\/:*?"<>|]+/g
// Non-global sibling for membership checks (a /g regex is stateful across .test() calls).
const PATH_HOSTILE_TEST_RE = /[\\/:*?"<>|]/

/** A plugin install error; `code` follows the host-mappable convention. */
export class InstallError extends Error {
  readonly code: "plugin-invalid" | "install-failed"
  constructor(message: string, code: "plugin-invalid" | "install-failed") {
    super(message)
    this.name = "InstallError"
    this.code = code
  }
}

/** The result of a successful (atomic) plugin install. */
export interface InstalledPlugin {
  /** `<mkt>__<name>` — same value the registry stores in PluginRecord.id. */
  id: string
  /** Absolute path of the installed copy under installRoot. */
  installPath: string
  capabilities: Capabilities
}

function failInvalid(message: string): never {
  throw new InstallError(message, "plugin-invalid")
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Strictly parse .mcp.json text into a MCP config record. Unknown fields are
 * dropped; known fields are type-checked (wrong types → plugin-invalid).
 */
function parseMcpConfigText(text: string, context: string): Record<string, MCP_CONFIG_SHAPE> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    failInvalid(`.mcp.json is not valid JSON (${context})`)
  }
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    failInvalid(`.mcp.json must be an object with an object 'mcpServers' field (${context})`)
  }
  const out: Record<string, MCP_CONFIG_SHAPE> = {}
  for (const [server, rawCfg] of Object.entries(raw.mcpServers)) {
    if (!isRecord(rawCfg)) {
      failInvalid(`.mcp.json server '${server}' must be an object (${context})`)
    }
    const cfg: MCP_CONFIG_SHAPE = {}
    for (const f of ["command", "cwd", "url"] as const) {
      const v = rawCfg[f]
      if (v === undefined) continue
      if (typeof v !== "string") {
        failInvalid(`.mcp.json server '${server}': '${f}' must be a string (${context})`)
      }
      cfg[f] = v
    }
    if (rawCfg.args !== undefined) {
      const args = rawCfg.args
      if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
        failInvalid(`.mcp.json server '${server}': 'args' must be an array of strings (${context})`)
      }
      cfg.args = [...args]
    }
    for (const f of ["env", "headers"] as const) {
      const v = rawCfg[f]
      if (v === undefined) continue
      if (!isRecord(v) || !Object.values(v).every((x) => typeof x === "string")) {
        failInvalid(`.mcp.json server '${server}': '${f}' must be an object of strings (${context})`)
      }
      cfg[f] = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val as string]))
    }
    out[server] = cfg
  }
  return out
}

/**
 * Read a plugin directory's MCP config as Record<string, MCP_CONFIG_SHAPE>.
 * No .mcp.json → {}. Installed copies carry the re-keyed server names
 * (`plugin:<mkt>__<name>:<server>`), so this is the direct RuntimeInputs
 * source for the host. A malformed .mcp.json → InstallError plugin-invalid.
 */
export async function readMcpServers(pluginDir: string): Promise<Record<string, MCP_CONFIG_SHAPE>> {
  let text: string
  try {
    text = await readFile(join(pluginDir, ".mcp.json"), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
    const reason = e instanceof Error ? e.message : String(e)
    throw new InstallError(`cannot read .mcp.json in ${pluginDir}: ${reason}`, "install-failed")
  }
  return parseMcpConfigText(text, pluginDir)
}

/**
 * Synchronous variant of readMcpServers — used by PluginRegistry.runtimeInputs()
 * which the host calls on every agent build (sync, no await). Same contract:
 * missing .mcp.json → {}, malformed → InstallError plugin-invalid.
 */
export function readMcpServersSync(pluginDir: string): Record<string, MCP_CONFIG_SHAPE> {
  let text: string
  try {
    text = readFileSync(join(pluginDir, ".mcp.json"), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
    const reason = e instanceof Error ? e.message : String(e)
    throw new InstallError(`cannot read .mcp.json in ${pluginDir}: ${reason}`, "install-failed")
  }
  return parseMcpConfigText(text, pluginDir)
}

/**
 * MCP server name grammar for mounted servers (mcp-client validateMcpConfig,
 * Task 8 ruling): `[A-Za-z0-9_.:-]` — colon is the namespace separator.
 * @private shared by the two exported helpers below.
 */
function sanitizeServerNamePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_.:-]/g, "_")
}

/**
 * The re-keyed MCP server name for an installed plugin: `plugin:<id>:<server>`
 * with BOTH parts sanitized to the server-name grammar — a marketplace DISPLAY
 * name with a space (real Claude Code marketplaces, e.g. "Marketplace A") or a
 * spaced server key must never make the plugin's whole MCP surface unmountable
 * (the validation skip used to swallow it: the plugin MCP 灯永不亮). The id
 * itself stays VERBATIM on record (state.json / install dir identity); only
 * the key composed here is the sanitized surface. Single source for the
 * install-time re-key AND for the host's per-plugin key attribution
 * (`mcpServerKeyPrefix`).
 */
export function mcpServerKey(id: string, server: string): string {
  return `plugin:${sanitizeServerNamePart(id)}:${sanitizeServerNamePart(server)}`
}

/** The key namespace prefix of one plugin id — the same sanitized id
 * `mcpServerKey` composes (the host attributes `mcpServerConfigs` keys to
 * their owning plugin by this prefix; both sides derive from the same
 * sanitizer, so a sanitized key always attributes to its raw-id record). */
export function mcpServerKeyPrefix(id: string): string {
  return `plugin:${sanitizeServerNamePart(id)}:`
}

/** Re-key the .mcp.json servers of a package dir to `mcpServerKey(id, server)`. */
async function rekeyMcpServers(pluginDir: string, id: string): Promise<void> {
  const file = join(pluginDir, ".mcp.json")
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return // no .mcp.json → no MCP config
    throw e
  }
  const config = parseMcpConfigText(text, pluginDir)
  const rekeyed: Record<string, MCP_CONFIG_SHAPE> = {}
  for (const [server, cfg] of Object.entries(config)) {
    rekeyed[mcpServerKey(id, server)] = cfg
  }
  await writeFile(file, JSON.stringify({ mcpServers: rekeyed }, null, 2), "utf8")
}

/** Prefix that makes `target.startsWith(p)` mean "target is strictly under base" (root-safe). */
function prefixOf(base: string): string {
  return base.endsWith(sep) ? base : base + sep
}

/** Lexical/realpath containment: `target` is `base` itself or strictly under it. */
function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(prefixOf(base))
}

/** realpathSync that returns null for paths that do not exist (ENOENT — a caller's concern). */
function realpathSafe(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Resolve a marketplace manifest entry's `source` against the marketplace
 * manifestDir. The result must stay within the marketplace's own directory —
 * checked lexically (`..` traversal and absolute paths outside manifestDir are
 * rejected) AND against realpaths: a symlink inside the marketplace (git
 * preserves them, local-dir marketplaces alike) whose target points outside is
 * rejected too, so an install can never read through a link from outside the
 * marketplace repository. Existence of the target is NOT checked here
 * (installPlugin reports it as plugin-invalid); a path that cannot be
 * realpath'd yet only gets the lexical check.
 *
 * Throws MarketplaceFetchError (code manifest-invalid) on any escape.
 */
export function resolveEntrySource(manifestDir: string, entrySource: string): string {
  const base = resolve(manifestDir)
  const resolved = resolve(base, entrySource)
  if (!isWithin(base, resolved)) {
    throw new MarketplaceFetchError(
      `plugin entry source ${JSON.stringify(entrySource)} resolves outside the marketplace directory ${base}`,
      "manifest-invalid",
    )
  }
  const realBase = realpathSafe(base)
  if (realBase !== null) {
    const realResolved = realpathSafe(resolved)
    if (realResolved !== null && !isWithin(realBase, realResolved)) {
      throw new MarketplaceFetchError(
        `plugin entry source ${JSON.stringify(entrySource)} resolves (through symlinks) outside the marketplace directory ${base}`,
        "manifest-invalid",
      )
    }
  }
  return resolved
}

/**
 * Clone a plugin repo into `dest` (per-plugin cache dir) — `--depth 1`; a
 * pinned ref/sha is then fetched + checked out (sha first when both are
 * pinned — the sha is the authoritative pin, the ref is the fallback when the
 * server cannot serve a fetch of the sha). The clone is re-pulled on every
 * install, mirroring the marketplace fetch (never serves a stale copy).
 * Throws MarketplaceFetchError (source-unreachable) when the clone or the pin
 * fetch/checkout fails.
 */
async function clonePluginRepo(
  url: string,
  dest: string,
  ref: string | undefined,
  sha: string | undefined,
): Promise<void> {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const gitOpts = { env, timeout: GIT_PLUGIN_CLONE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--", url, dest], gitOpts)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new MarketplaceFetchError(
      `git clone failed for plugin source ${url}: ${reason}`,
      "source-unreachable",
    )
  }
  const pins: string[] = []
  if (sha !== undefined) pins.push(sha)
  if (ref !== undefined && ref !== sha) pins.push(ref)
  for (const pin of pins) {
    try {
      await execFileAsync("git", ["-C", dest, "fetch", "--depth", "1", "origin", pin], gitOpts)
      await execFileAsync("git", ["-C", dest, "checkout", "--detach", "FETCH_HEAD"], gitOpts)
      return
    } catch {
      // try the next pin (sha first, then ref)
    }
  }
  if (pins.length > 0) {
    throw new MarketplaceFetchError(
      `cannot fetch/checkout pinned ref/sha ${pins.join(", ")} for plugin source ${url}`,
      "source-unreachable",
    )
  }
}

/**
 * Resolve a marketplace manifest entry's `source` to a concrete local plugin
 * directory (bug fix 1 — object sources):
 *   - string / directory / file: resolved against the marketplace's own
 *     manifestDir via the resolveEntrySource containment rule (a `file`
 *     source names a single plugin file; the plugin package unit in this
 *     registry is a DIRECTORY, so its parent dir is the copy source).
 *   - git-subdir / url / github / git: the repo is cloned into the caller's
 *     per-plugin cache dir (`<registryRoot>/cache/plugins/<mkt>__<plugin>`)
 *     with the pins honored, then `path` (git-subdir) or the repo ROOT
 *     (url/git; github = path subdir) is the plugin source dir. The subdir is
 *     subject to the same containment rule — relative to the clone dir.
 * Throws MarketplaceFetchError (manifest-invalid / source-unreachable).
 */
export async function resolveInstallSource(opts: {
  source: PluginSource
  manifestDir: string
  pluginCacheDir: string
}): Promise<string> {
  const { source, manifestDir, pluginCacheDir } = opts
  if (typeof source === "string") return resolveEntrySource(manifestDir, source)
  switch (source.source) {
    case "directory":
      return resolveEntrySource(manifestDir, source.path)
    case "file":
      return dirname(resolveEntrySource(manifestDir, source.path))
    case "git-subdir": {
      await clonePluginRepo(source.url, pluginCacheDir, source.ref, source.sha)
      return resolveEntrySource(pluginCacheDir, source.path)
    }
    case "url": {
      await clonePluginRepo(source.url, pluginCacheDir, undefined, source.sha)
      return pluginCacheDir
    }
    case "github": {
      await clonePluginRepo(githubGitUrl(source.repo), pluginCacheDir, undefined, undefined)
      return source.path !== undefined ? resolveEntrySource(pluginCacheDir, source.path) : pluginCacheDir
    }
    case "git": {
      await clonePluginRepo(source.url, pluginCacheDir, source.ref, source.sha)
      return pluginCacheDir
    }
    default: {
      const exhaustive: never = source
      failInvalid(`unknown plugin source form: ${JSON.stringify(exhaustive)}`)
    }
  }
}

function idPart(s: string, label: string): string {
  const cleaned = s.trim().replace(PATH_HOSTILE_RE, "-").replace(/-{2,}/g, "-")
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    failInvalid(`${label} ${JSON.stringify(s)} is not a valid install id component`)
  }
  return cleaned
}

/**
 * The install id for a plugin: `<mkt>__<name>` (path-hostile characters
 * normalized to "-", so the id is always one safe path component). This is the
 * single source of truth for the id — the install dir name, the registry's
 * PluginRecord.id and the MCP re-key prefix (`plugin:<id>:<server>`).
 */
export function pluginId(marketplace: string, name: string): string {
  return `${idPart(marketplace, "marketplace")}__${idPart(name, "plugin name")}`
}

/** True only for ids produced by pluginId/installPlugin: `<part>__<part>` with
 * non-empty parts and no path-hostile characters. Excludes single-component
 * ids such as "skills"/"commands", which uninstall would otherwise resolve to
 * a whole materialize subtree shared by every plugin. */
function isValidPluginId(id: string): boolean {
  if (typeof id !== "string" || id === "" || id === "." || id === "..") return false
  if (PATH_HOSTILE_TEST_RE.test(id)) return false
  const idx = id.indexOf("__")
  return idx > 0 && idx < id.length - 2
}

/** Delete leftover `.id.tmp-*` / `.id.old-*` artifacts of a crash during a
 * previous install of the same id (self-healing before staging anything new). */
async function removeStaleArtifacts(root: string, id: string): Promise<void> {
  const prefixes = [`.${id}.tmp-`, `.${id}.old-`]
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return // root missing (created just before) or unreadable → nothing to clean
  }
  for (const name of names) {
    if (prefixes.some((p) => name.startsWith(p))) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Atomically install a plugin package: copy `sourceDir` into a temp dir inside
 * installRoot, re-key its .mcp.json, then rename into
 * `<installRoot>/<mkt>__<name>`. Overwrite of an existing install is
 * two-phase (park old → swap new → drop old), so re-installing is idempotent
 * and a crash or rename failure at any step leaves either the old or the new
 * copy plainly present — never nothing. Throws InstallError (plugin-invalid /
 * install-failed); never leaves a partial install or temp dir behind.
 */
export async function installPlugin(
  sourceDir: string,
  marketplace: string,
  name: string,
  installRoot: string,
): Promise<InstalledPlugin> {
  const id = pluginId(marketplace, name)
  const src = resolve(sourceDir)
  const root = resolve(installRoot)
  const installPath = join(root, id)
  if (!existsSync(src)) {
    failInvalid(`plugin source directory does not exist: ${src}`)
  }
  // Staged and parked copies live in installRoot so the renames stay on one volume.
  const tmp = join(root, `.${id}.tmp-${randomUUID()}`)
  const parked = join(root, `.${id}.old-${randomUUID()}`)
  try {
    await mkdir(root, { recursive: true })
    await removeStaleArtifacts(root, id)
    // Dereference symlinks: the installed copy is a plain file tree, so no
    // file inside installRoot is ever a link whose live content escapes it.
    await cp(src, tmp, { recursive: true, dereference: true })
    await rekeyMcpServers(tmp, id)
    let parkedPath: string | null = null
    if (existsSync(installPath)) {
      await rename(installPath, parked) // phase 1: park the old copy
      parkedPath = parked
    }
    try {
      await rename(tmp, installPath) // phase 2: swap the new copy in
    } catch (e) {
      // Restore the parked copy (best effort — if it too fails, the old copy
      // remains plainly present as `.id.old-*` next to the install path).
      if (parkedPath !== null) await rename(parkedPath, installPath).catch(() => {})
      throw e
    }
    if (parkedPath !== null) {
      await rm(parkedPath, { recursive: true, force: true }) // phase 3: drop the old copy
    }
    return { id, installPath, capabilities: inspectCapabilities(installPath) }
  } catch (e) {
    if (e instanceof InstallError) throw e
    const reason = e instanceof Error ? e.message : String(e)
    throw new InstallError(`install failed: ${reason}`, "install-failed")
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Remove an installed plugin (idempotent — a missing install is a no-op):
 * the install dir plus the materialize-leftover dirs `<root>/skills/<id>` and
 * `<root>/commands/<id>` (laid out by Task 4's enable()). The id must have the
 * `<part>__<part>` shape — this rejects path-hostile characters, traversal,
 * and single-component ids like "skills"/"commands" that would collide with a
 * materialize root and wipe every plugin's subtree.
 */
export async function uninstallPlugin(id: string, installRoot: string): Promise<void> {
  if (!isValidPluginId(id)) {
    failInvalid(`malformed plugin id: ${JSON.stringify(id)} (expected <mkt>__<name>)`)
  }
  const root = resolve(installRoot)
  await rm(join(root, id), { recursive: true, force: true })
  await rm(join(root, "skills", id), { recursive: true, force: true })
  await rm(join(root, "commands", id), { recursive: true, force: true })
}
