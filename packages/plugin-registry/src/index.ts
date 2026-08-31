/**
 * PluginRegistry — the host-facing plugin lifecycle: sources (add/refresh/
 * remove), install/uninstall, enable/disable, catalog, and the synchronous
 * runtime inputs the host reads on every agent build (Task 8's web.ts).
 *
 * Root layout (all under `root`):
 *   state.json                    durable state (version 1, atomic writes)
 *   cache/<cacheNameForSource>/   fetched/cloned marketplace copies
 *   <mkt>__<name>/                installed plugin copy (never executed)
 *   skills/<mkt>__<name>/         materialized on enable (read-only overlay)
 *   commands/<mkt>__<name>/       materialized on enable (markdown commands)
 *
 * Conventions (spec D2/D5/D6):
 *   - Plugin code is never executed anywhere here: manifests, package.json and
 *     .mcp.json are only parsed; commands are only read as markdown.
 *   - enable() validates BEFORE any state write (installed? install dir present?
 *     any usable capability?). A broken enable throws PluginArtifactError and
 *     leaves state untouched — no partial enable.
 *   - D5 naming conflicts are NOT a failure: enable succeeds, the conflicting
 *     commands are not registered and are recorded on the plugin record
 *     (`conflicts: [{name, reason}]`) for the UI's failed(部分) badge. The host
 *     never renames; blocked commands reactivate on the next re-enable.
 *   - Running live agents are never touched; the next agent build picks up
 *     runtimeInputs(). catalog() serves cached manifests (offline-friendly);
 *     refreshSource() re-pulls.
 */

import { existsSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspectCapabilities } from "./capability.ts"
import { describeCommands } from "./commands.ts"
import {
  InstallError,
  installPlugin,
  pluginId,
  readMcpServersSync,
  resolveInstallSource,
  uninstallPlugin,
} from "./install.ts"
import { materializePlugin } from "./materialize.ts"
import {
  cacheNameForSource,
  fetchSource,
  MarketplaceFetchError,
  parseManifest,
  type MarketplaceEntry,
  type MarketplaceManifest,
} from "./marketplaces.ts"
import { loadState, loadStateSync, saveState } from "./state.ts"
import type {
  CatalogPlugin,
  CommandConflict,
  CommandDescriptor,
  MCP_CONFIG_SHAPE,
  PluginRecord,
  PluginSourceInfo,
  PluginState,
  RegistryOptions,
  RuntimeInputs,
} from "./types.ts"
import {
  PluginArtifactError,
  PluginNotFoundError,
  SourceConflictError,
  SourceNotFoundError,
} from "./types.ts"

export {
  SourceConflictError,
  SourceNotFoundError,
  PluginArtifactError,
  PluginConflictError,
  PluginNotFoundError,
  type MCP_CONFIG_SHAPE,
  type CatalogPlugin,
  type CommandConflict,
  type CommandDescriptor,
  type PluginRecord,
  type PluginSourceInfo,
  type PluginState,
  type RegistryOptions,
  type RuntimeInputs,
} from "./types.ts"
export { inspectCapabilities, type Capabilities, type Capability } from "./capability.ts"
export {
  InstallError,
  installPlugin,
  mcpServerKey,
  mcpServerKeyPrefix,
  pluginId,
  readMcpServers,
  readMcpServersSync,
  resolveEntrySource,
  resolveInstallSource,
  uninstallPlugin,
  type InstalledPlugin,
} from "./install.ts"
export { loadState, loadStateSync, saveState } from "./state.ts"
export {
  MarketplaceFetchError,
  cacheNameForSource,
  fetchSource,
  githubGitUrl,
  parseManifest,
  type MarketplaceEntry,
  type MarketplaceManifest,
  type PluginSource,
  type PluginSourceDirectory,
  type PluginSourceFile,
  type PluginSourceGit,
  type PluginSourceGitSubdir,
  type PluginSourceGithub,
  type PluginSourceUrl,
} from "./marketplaces.ts"
export { describeCommands, parseCommandMarkdown } from "./commands.ts"
export { evaluatePlugin, type CapabilityStatus, type CommandStatus, type EvaluateResult, type Observations, type OverallStatus } from "./evaluate.ts"
export { materializePlugin, type MaterializedPlugin } from "./materialize.ts"

function byIdCompare(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byNameCompare(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Pure conflict check: command names a plugin provides vs names already owned
 * (the host's interaction catalog, other enabled plugins). Returns the
 * conflicting names. Per D5 the registry does NOT reject on these — enable()
 * records each blocked command on the plugin record (conflicts: [{name,
 * reason}]) and runtimeInputs() excludes it.
 */
export function validateCompatibility(
  commands: CommandDescriptor[],
  existing: { name: string }[],
): { conflicts: string[] } {
  const existingNames = new Set(existing.map((e) => e.name))
  const conflicts = [...new Set(commands.map((c) => c.name).filter((n) => existingNames.has(n)))].sort()
  return { conflicts }
}

export class PluginRegistry {
  private readonly root: string
  private readonly cacheDir: string
  private readonly existingCommandNames: () => string[]

  constructor(opts: RegistryOptions) {
    this.root = resolve(opts.root)
    this.cacheDir = join(this.root, "cache")
    const existing = opts.existingCommandNames ?? []
    this.existingCommandNames = typeof existing === "function" ? existing : () => existing
  }

  /** Registered sources with their collect status (error = manifest unreadable). */
  async listSources(): Promise<{ name: string; source: string; lastUpdated: number; error?: string }[]> {
    const state = await loadState(this.root)
    const out: { name: string; source: string; lastUpdated: number; error?: string }[] = []
    for (const src of state.sources) {
      const entry = { name: src.name, source: src.source, lastUpdated: src.lastUpdated }
      try {
        await this.collectSource(src.source)
      } catch (e) {
        out.push({ ...entry, error: e instanceof Error ? e.message : String(e) })
        continue
      }
      out.push(entry)
    }
    return out
  }

  /**
   * Register a marketplace source (4 forms: local dir, http(s) marketplace.json
   * URL, `owner/repo`, git URL). The manifest is fetched first, so an
   * unreachable/invalid source is rejected before any state write. Re-adding
   * the same source string refreshes it; a DIFFERENT source string claiming the
   * same marketplace name is rejected (SourceConflictError).
   */
  async addSource(source: string): Promise<{ source: PluginSourceInfo; plugins: MarketplaceEntry[] }> {
    const trimmed = source.trim()
    if (trimmed === "") {
      throw new MarketplaceFetchError("marketplace source is empty", "manifest-invalid")
    }
    const { manifest } = await fetchSource(trimmed, this.cacheDir)
    const state = await loadState(this.root)
    const exact = state.sources.find((s) => s.source === trimmed)
    if (exact !== undefined) {
      exact.lastUpdated = Date.now()
      await saveState(this.root, state)
      return { source: { ...exact }, plugins: manifest.plugins }
    }
    const sameName = state.sources.find((s) => s.name === manifest.name)
    if (sameName !== undefined) {
      throw new SourceConflictError(
        `a marketplace named "${manifest.name}" is already registered from ${sameName.source}`,
      )
    }
    const info: PluginSourceInfo = { name: manifest.name, source: trimmed, lastUpdated: Date.now() }
    state.sources.push(info)
    await saveState(this.root, state)
    return { source: info, plugins: manifest.plugins }
  }

  /** Re-pull a registered source's manifest and bump its lastUpdated. */
  async refreshSource(name: string): Promise<void> {
    const state = await loadState(this.root)
    const src = state.sources.find((s) => s.name === name)
    if (src === undefined) throw new SourceNotFoundError(`source not found: ${name}`)
    await fetchSource(src.source, this.cacheDir) // throws on failure; state untouched
    src.lastUpdated = Date.now()
    await saveState(this.root, state)
  }

  /** Drop a source and its cache copy; installed plugins and their state stay. */
  async removeSource(name: string): Promise<void> {
    const state = await loadState(this.root)
    const idx = state.sources.findIndex((s) => s.name === name)
    if (idx === -1) throw new SourceNotFoundError(`source not found: ${name}`)
    const [removed] = state.sources.splice(idx, 1)
    await rm(join(this.cacheDir, cacheNameForSource(removed!.source)), { recursive: true, force: true })
    await saveState(this.root, state)
  }

  /**
   * The merged discovery: every registered source's manifest entries overlaid
   * with registry state (installed/enabled/capabilities), plus records whose
   * marketplace no longer yields an entry (source removed or renamed — their
   * `source` falls back to ""). Sorted by id.
   */
  async catalog(): Promise<{ plugins: CatalogPlugin[] }> {
    const state = await loadState(this.root)
    const byId = new Map<string, CatalogPlugin>()
    for (const src of state.sources) {
      let collected: { manifest: MarketplaceManifest }
      try {
        collected = await this.collectSource(src.source)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        console.warn(`[plugin-registry] catalog: source ${src.name} (${src.source}) unreadable: ${reason}`)
        continue
      }
      for (const entry of collected.manifest.plugins) {
        const id = pluginId(collected.manifest.name, entry.name)
        const existing = byId.get(id)
        if (existing !== undefined) {
          // id normalization ambiguity (e.g. "a:b" and "a/b" both → "a-b").
          // Documented v1 behavior: the first registered source wins, the host
          // is warned, install() resolves the same way (findEntry order).
          if (existing.source !== src.source || existing.name !== entry.name) {
            console.warn(
              `[plugin-registry] catalog: duplicate plugin id ${id} (${existing.marketplace}/${existing.name} vs ${collected.manifest.name}/${entry.name}); keeping the first`,
            )
          }
          continue
        }
        const rec = state.plugins.find((p) => p.id === id)
        const installed = rec !== undefined && rec.installed
        byId.set(id, {
          id,
          marketplace: collected.manifest.name,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          tags: entry.tags !== undefined ? [...entry.tags] : undefined,
          source: src.source,
          installed,
          enabled: installed && rec!.enabled,
          ...(installed ? { capabilities: inspectCapabilities(join(this.root, id)) } : {}),
          ...(rec !== undefined && rec.conflicts !== undefined ? { conflicts: [...rec.conflicts] } : {}),
        })
      }
    }
    // records not covered by any current source (its source was removed / the
    // marketplace entry vanished) still appear, with the installed & enabled flags
    for (const rec of state.plugins) {
      if (byId.has(rec.id)) continue
      byId.set(rec.id, {
        id: rec.id,
        marketplace: rec.marketplace,
        name: rec.name,
        source: state.sources.find((s) => s.name === rec.marketplace)?.source ?? "",
        installed: rec.installed,
        enabled: rec.enabled,
        ...(rec.installed ? { capabilities: inspectCapabilities(join(this.root, rec.id)) } : {}),
        ...(rec.conflicts !== undefined ? { conflicts: [...rec.conflicts] } : {}),
      })
    }
    return { plugins: [...byId.values()].sort(byIdCompare) }
  }

  /**
   * Install a catalog-discovered plugin: the marketplace entry identified by
   * `id` (the first registered source listing it wins) is resolved against its
   * marketplace dir, copied into `<root>/<id>` atomically and recorded in state
   * (installed=true, enabled kept). Reinstalling an enabled plugin re-runs the
   * materialization so the runtime copy stays fresh. If that materialization
   * fails, the plugin is atomically DISABLED (complete consistent state:
   * enabled=false, conflicts cleared, half-copied overlays dropped) before the
   * error surfaces — the new install copy stays and a later enable()
   * re-materializes it; a mixed surface (new MCP, old/missing overlays, stale
   * enabled+conflicts) is never persisted.
   */
  async install(id: string): Promise<void> {
    const state = await loadState(this.root)
    const found = await this.findEntry(state, id)
    if (found === undefined) {
      throw new PluginNotFoundError(
        `plugin ${JSON.stringify(id)} is not listed by any registered marketplace`,
      )
    }
    // Bug fix 1: object sources (git-subdir/url/github/git/directory/file) are
    // materialized here — a string source resolves inside the marketplace dir
    // (string behavior kept), an object source is cloned into a per-plugin
    // cache dir (<cache>/plugins/<id>) with its pins honored, then the subdir
    // (or clone root) sourced. The clone lives OUTSIDE the marketplace cache
    // dir — re-cloned per install, never serving stale content.
    const sourceDir = await resolveInstallSource({
      source: found.entry.source,
      manifestDir: found.manifestDir,
      pluginCacheDir: join(this.cacheDir, "plugins", id),
    })
    const result = await installPlugin(sourceDir, found.manifest.name, found.entry.name, this.root)
    const rec = state.plugins.find((p) => p.id === id)
    if (rec === undefined) {
      state.plugins.push({
        id,
        marketplace: found.manifest.name,
        name: found.entry.name,
        installPath: result.installPath,
        installed: true,
        enabled: false,
      })
    } else {
      rec.installPath = result.installPath
      rec.installed = true
      if (rec.enabled) {
        // Re-materialize and refresh the recorded D5 limitation (the refreshed
        // command set may have gained/lost conflicts vs the host catalog).
        const installPath = join(this.root, id)
        try {
          await this.materialize(installPath, id)
          this.applyConflicts(rec, this.computeConflicts(state, rec, installPath))
        } catch (e) {
          // The new install copy is already live (the two-phase swap completed)
          // but the overlays were dropped/copied mid-failure. A mixed runtime
          // surface must not persist: atomically write a COMPLETE consistent
          // state — the plugin becomes disabled with its limitation cleared —
          // drop any half-copied overlay, then let the error surface. A
          // subsequent enable() re-materializes from the new copy.
          rec.enabled = false
          delete rec.conflicts
          await rm(join(this.root, "skills", id), { recursive: true, force: true }).catch(() => {})
          await rm(join(this.root, "commands", id), { recursive: true, force: true }).catch(() => {})
          try {
            await saveState(this.root, state)
          } catch {
            // already surfacing the materialize error; state stays stale on a
            // disk fault that no recovery can fix here
          }
          throw e
        }
      }
    }
    await saveState(this.root, state)
  }

  /**
   * Remove a plugin (idempotent): install dir + materialized dirs + state
   * record. Unknown ids are a validated no-op, so a repeated uninstall of an
   * already-gone plugin succeeds; malformed ids (traversal, single-component)
   * are rejected as InstallError plugin-invalid before anything is touched.
   */
  async uninstall(id: string): Promise<void> {
    const state = await loadState(this.root)
    try {
      await uninstallPlugin(id, this.root)
    } catch (e) {
      if (e instanceof InstallError) throw e
      const reason = e instanceof Error ? e.message : String(e)
      throw new InstallError(`uninstall failed: ${reason}`, "install-failed")
    }
    const idx = state.plugins.findIndex((p) => p.id === id)
    if (idx !== -1) state.plugins.splice(idx, 1)
    await saveState(this.root, state)
  }

  /**
   * Enable a plugin: validate (installed? install dir present? any usable
   * capability?) → evaluate command-name conflicts → materialize → write state
   * → new runtime inputs. A broken enable (artifact class) throws and writes
   * NOTHING (no partial enable). Naming conflicts per D5 are recorded, not a
   * rejection: the plugin enables and the blocked commands stay unregistered.
   * Enabling an already-enabled id is an idempotent no-op.
   */
  async enable(id: string): Promise<RuntimeInputs> {
    const state = await loadState(this.root)
    const rec = state.plugins.find((p) => p.id === id)
    if (rec === undefined) throw new PluginNotFoundError(`plugin ${JSON.stringify(id)} is not installed`)
    if (rec.enabled) return this.runtimeInputs() // idempotent
    if (!rec.installed) {
      throw new PluginArtifactError(`plugin ${JSON.stringify(id)} is not installed (run install first)`)
    }
    const installPath = join(this.root, rec.id)
    if (!existsSync(installPath)) {
      throw new PluginArtifactError(`install directory is missing for ${JSON.stringify(id)} (${installPath})`)
    }
    const capabilities = inspectCapabilities(installPath)
    if (!capabilities.skills && !capabilities.commands && !capabilities.mcp) {
      throw new PluginArtifactError(
        `plugin ${JSON.stringify(id)} has no usable capabilities (no skills/, commands/ or .mcp.json)`,
      )
    }
    const conflicts = this.computeConflicts(state, rec, installPath)
    await this.materialize(installPath, id)
    rec.enabled = true
    this.applyConflicts(rec, conflicts)
    await saveState(this.root, state)
    return this.runtimeInputs()
  }

  /**
   * Disable a plugin (idempotent): remove the materialized dirs + state flag,
   * and clear the recorded D5 limitation (it only applies while enabled).
   * The installed copy is kept (re-enable re-materializes it).
   */
  async disable(id: string): Promise<RuntimeInputs> {
    const state = await loadState(this.root)
    const rec = state.plugins.find((p) => p.id === id)
    if (rec === undefined) throw new PluginNotFoundError(`plugin ${JSON.stringify(id)} is not installed`)
    try {
      await rm(join(this.root, "skills", id), { recursive: true, force: true })
      await rm(join(this.root, "commands", id), { recursive: true, force: true })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new PluginArtifactError(
        `removing materialized files of plugin ${JSON.stringify(id)} failed: ${reason}`,
      )
    }
    if (rec.enabled) rec.enabled = false
    delete rec.conflicts
    await saveState(this.root, state)
    return this.runtimeInputs()
  }

  /**
   * Current enabled set, rebuilt synchronously from state + disk on every call
   * (web.ts reads this per agent build). Skill dirs and command descriptors
   * come from the materialized copies (minus each record's D5-blocked
   * commands); MCP config from the re-keyed installed copies; a plugin whose
   * install dir vanished is skipped with a warning.
   */
  runtimeInputs(): RuntimeInputs {
    const state = loadStateSync(this.root)
    const enabled = state.plugins.filter((p) => p.enabled).sort(byIdCompare)
    const skillDirs: string[] = []
    const mcpServerConfigs: Record<string, MCP_CONFIG_SHAPE> = {}
    const commandDescriptors: CommandDescriptor[] = []
    for (const rec of enabled) {
      const skillDir = join(this.root, "skills", rec.id)
      if (existsSync(skillDir)) skillDirs.push(skillDir)
      try {
        Object.assign(mcpServerConfigs, readMcpServersSync(join(this.root, rec.id)))
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        console.warn(`[plugin-registry] runtime: skipping MCP config of ${rec.id}: ${reason}`)
      }
      commandDescriptors.push(...this.effectiveDescriptors(rec))
    }
    commandDescriptors.sort(byNameCompare)
    return { skillDirs, mcpServerConfigs, commandDescriptors }
  }

  /**
   * Read a source's manifest: a local directory is always read in place; a
   * cache-backed source is served from its deterministic cache dir when that
   * copy is usable (catalog is offline-friendly), otherwise re-pulled.
   */
  private async collectSource(source: string): Promise<{ manifest: MarketplaceManifest; manifestDir: string }> {
    try {
      if (existsSync(source) && statSync(source).isDirectory()) {
        const manifestDir = resolve(source)
        return { manifestDir, manifest: parseManifest("", manifestDir) }
      }
      const cached = join(this.cacheDir, cacheNameForSource(source))
      if (existsSync(cached)) {
        try {
          return { manifestDir: cached, manifest: parseManifest("", cached) }
        } catch {
          // cached copy unusable → fall through to a fresh pull
        }
      }
      return await fetchSource(source, this.cacheDir)
    } catch (e) {
      if (e instanceof MarketplaceFetchError) throw e
      const reason = e instanceof Error ? e.message : String(e)
      throw new MarketplaceFetchError(`cannot read marketplace source: ${reason}`, "source-unreachable")
    }
  }

  /** Find the marketplace entry that produced `id` (first registered source wins). */
  private async findEntry(
    state: PluginState,
    id: string,
  ): Promise<{ manifest: MarketplaceManifest; manifestDir: string; entry: MarketplaceEntry } | undefined> {
    for (const src of state.sources) {
      let collected: { manifest: MarketplaceManifest; manifestDir: string }
      try {
        collected = await this.collectSource(src.source)
      } catch {
        continue // an unreadable source contributes no entries
      }
      const entry = collected.manifest.plugins.find(
        (e) => pluginId(collected.manifest.name, e.name) === id,
      )
      if (entry !== undefined) return { manifest: collected.manifest, manifestDir: collected.manifestDir, entry }
    }
    return undefined
  }

  /**
   * D5 conflict evaluation for one enable: own commands vs the host catalog
   * plus the commands ACTUALLY registered by other enabled plugins (their own
   * recorded conflicts are themselves excluded — a blocked command does not
   * claim a name). Returns the blocked commands with a reason each.
   */
  private computeConflicts(
    state: PluginState,
    rec: PluginRecord,
    installPath: string,
  ): CommandConflict[] {
    const claimed = new Map<string, string>() // command name → claim reason
    for (const name of this.existingCommandNames()) {
      claimed.set(name, "already registered by the host")
    }
    for (const other of state.plugins) {
      if (!other.enabled || other.id === rec.id) continue
      for (const desc of this.effectiveDescriptors(other)) {
        if (!claimed.has(desc.name)) {
          claimed.set(desc.name, `already provided by enabled plugin ${other.id}`)
        }
      }
    }
    const conflicts: CommandConflict[] = []
    for (const desc of describeCommands(join(installPath, "commands"))) {
      const reason = claimed.get(desc.name)
      if (reason !== undefined) conflicts.push({ name: desc.name, reason })
    }
    return conflicts.sort(byNameCompare)
  }

  /** A record's actually-registered descriptors: materialized copy minus its
   * D5-blocked commands (used by runtimeInputs and by conflict evaluation of
   * LATER enables). */
  private effectiveDescriptors(rec: PluginRecord): CommandDescriptor[] {
    const blocked = new Set((rec.conflicts ?? []).map((c) => c.name))
    return describeCommands(join(this.root, "commands", rec.id)).filter((d) => !blocked.has(d.name))
  }

  /** Write the D5 limitation onto a record (empty → field removed, kept clean). */
  private applyConflicts(rec: PluginRecord, conflicts: CommandConflict[]): void {
    if (conflicts.length > 0) rec.conflicts = conflicts
    else delete rec.conflicts
  }

  /** Materialize wrapper: an I/O failure of the copy surfaces as PluginArtifactError. */
  private async materialize(installPath: string, id: string): Promise<void> {
    try {
      await materializePlugin(installPath, id, this.root)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new PluginArtifactError(`materializing plugin ${JSON.stringify(id)} failed: ${reason}`)
    }
  }
}
