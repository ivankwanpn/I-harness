import type { Capabilities } from "./capability.ts"

/** One collected marketplace origin (where plugin metadata was fetched from). */
export interface PluginSourceInfo {
  name: string
  source: string
  lastUpdated: number
}

/** One command blocked at enable time (D5): the name was already claimed by
 * the host catalog or by another enabled plugin. The command is NOT registered
 * — the plugin still enables, with the limitation recorded. */
export interface CommandConflict {
  name: string
  reason: string
}

/** One plugin record tracked by the registry. */
export interface PluginRecord {
  id: string
  marketplace: string
  name: string
  installPath: string
  installed: boolean
  enabled: boolean
  /** Commands blocked at enable time (D5); present only while enabled (enable
   * writes it, disable clears it, re-enable re-evaluates it). */
  conflicts?: CommandConflict[]
}

/** The durable plugin registry document shape (version-gated). */
export interface PluginState {
  version: 1
  sources: PluginSourceInfo[]
  plugins: PluginRecord[]
}

/**
 * Shape of one MCP server entry in a plugin's .mcp.json (and of the merged
 * runtime config consumed by the host): the stdio fields (command/args/cwd/env)
 * or the streamable-http fields (url/headers). Shared between the install
 * re-keying step and the runtime consumer, so both agree on one shape.
 */
export type MCP_CONFIG_SHAPE = {
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** One markdown command discovered in a plugin's commands/*.md (name = file name). */
export interface CommandDescriptor {
  name: string
  description?: string
  argumentHints?: string
  body: string
}

/** The runtime surface enable() produces and the host consumes on every agent
 * build: materialized skill dirs (read-only overlays), the re-keyed MCP config
 * (`plugin:<id>:<server>` keys) and the markdown command descriptors. */
export interface RuntimeInputs {
  skillDirs: string[]
  mcpServerConfigs: Record<string, MCP_CONFIG_SHAPE>
  commandDescriptors: CommandDescriptor[]
}

/** One plugin as listed by catalog(): merged manifest metadata + registry state. */
export interface CatalogPlugin {
  id: string
  marketplace: string
  name: string
  description?: string
  category?: string
  tags?: string[]
  /** The registered source string the plugin was discovered from ("" once its
   * source has been removed and nothing else can locate it). */
  source: string
  installed: boolean
  enabled: boolean
  capabilities?: Capabilities
  /** Commands blocked at enable time (D5) — the UI shows them as failed(部分). */
  conflicts?: CommandConflict[]
}

/** PluginRegistry construction options. */
export interface RegistryOptions {
  /** Registry root (e.g. ~/.i-harness/plugins): state.json, cache/, installed
   * copies and the materialized skills/ + commands/ trees live under it. */
  root: string
  /** Command names already claimed by the host (e.g. the programmatic
   * interaction catalog). A function is accepted so commands registered after
   * construction are honored; defaults to an empty catalog (no conflicts).
   * Wired to the interaction catalog by Task 7/8. */
  existingCommandNames?: string[] | (() => string[])
}

/**
 * Referenced plugin source does not exist (or was never collected).
 * Code convention mirrors packages/workspace error classes: a `code` field
 * the host maps to HTTP statuses without string matching.
 */
export class SourceNotFoundError extends Error {
  readonly code = "source-not-found" as const
  constructor(message: string) {
    super(message)
    this.name = "SourceNotFoundError"
  }
}

/**
 * Two different sources claim the same marketplace name — the registry must
 * not silently merge them (id/name ambiguity). The caller hands the user an
 * input-level error, not a state mutation.
 */
export class SourceConflictError extends Error {
  readonly code = "source-name-conflict" as const
  constructor(message: string) {
    super(message)
    this.name = "SourceConflictError"
  }
}

/**
 * Retained for conflict-shaped failures the host maps to 409. Per D5, plain
 * naming conflicts do NOT throw anymore: enable() succeeds and records the
 * blocked commands on the plugin record's `conflicts` field (the host presents
 * them as a failed(部分) badge). Enable-time failures of the artifact kind
 * (not installed, missing dir, no capabilities, materialization I/O) throw
 * PluginArtifactError; this class is reserved for future conflict classes that
 * genuinely block an operation (e.g. a stale/concurrent state conflict).
 */
export class PluginConflictError extends Error {
  readonly code = "plugin-conflict" as const
  readonly conflicts: string[]
  constructor(conflicts: string[]) {
    super(
      `plugin conflicts with already registered commands of the same name: ${conflicts.join(", ")}`,
    )
    this.name = "PluginConflictError"
    this.conflicts = [...conflicts]
  }
}

/** A plugin enabling failed on its artifacts (not installed, missing install
 * dir, no usable capabilities, materialization I/O failure). */
export class PluginArtifactError extends Error {
  readonly code = "plugin-artifact" as const
  constructor(message: string) {
    super(message)
    this.name = "PluginArtifactError"
  }
}

/** The referenced plugin id is unknown to the registry (no record). */
export class PluginNotFoundError extends Error {
  readonly code = "plugin-not-found" as const
  constructor(message: string) {
    super(message)
    this.name = "PluginNotFoundError"
  }
}
