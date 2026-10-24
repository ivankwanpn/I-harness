import type { Telemetry } from "@i-harness/telemetry"
import type { FsWatchService } from "@i-harness/fs-watch"
import type { SettingsWatchError } from "../observation/watch-settings.ts"
import type { Settings } from "../schema/types.ts"
import type { LayeredRoots } from "./layers.ts"

export interface SettingsStoreOptions {
  /** Document path; defaults to `<configDir>/settings.json` (see defaultSettingsPath). */
  path?: string
  /** Config home used when `path` is omitted; defaults to `$IH_CONFIG_DIR` or `~/.i-harness`. */
  configDir?: string
}

export interface ObservedSettingsLoadOptions {
  /** Runs once on an isolated recursively frozen copy of the saved document. */
  validate?: (document: Readonly<Record<string, unknown>>) => void
}

export type ObservedSettingsLoad =
  | { kind: "loaded"; settings: Settings; stamp: { kind: "present"; sha256: string } }
  | { kind: "missing"; stamp: { kind: "missing" } }

/** A section draft's saved revision, checked inside the serialized write. */
export interface SettingsRevisionGuard { section: string; expectedRevision: number }

export interface LayeredStoreOptions {
  /** Explicit host-selected global profile for legacy import when using files.
   * Must be absolute and name exactly one configured source. Without selection,
   * files mode cannot import or create native profile provenance. Roots mode
   * defaults to its global source; workspace/project roots are never eligible.
   * Selecting a profile does not itself authorize legacy probes: an explicit
   * digest-bound migrateInstructions request is still required. */
  instructionProfilePath?: string
  /** Explicit ordered file list (LOW → HIGH priority). Takes precedence over
   * `roots` when both are given. */
  files?: string[]
  /** Conventional roots; each is either an explicit path or "auto" (resolved
   * by the store: global = configDir/settings.json, workspace =
   * <workspace>/.i-harness/settings.json, project = <cwd>/settings.json). */
  roots?: LayeredRoots
  /** Config home for the global root default; defaults to `$IH_CONFIG_DIR` or
   * `~/.i-harness` (same chain as resolveSettingsPath). */
  configDir?: string
  /** Workspace root for the workspace layer default (absent → process.cwd()). */
  workspace?: string
  /** Numeric values are deprecated and ignored; W1 owns retry timing.
   * `false` disables watching entirely. */
  watchIntervalMs?: number | false
  watchService?: FsWatchService
  onWatchError?: (failure: SettingsWatchError) => void
  /** M40 A6: host telemetry stream for the hot-reload change notification
   * (`settings/changed` — the manifest code is declared; this is its producer).
   * Per-change emits carry `data: { path }` (the changed file). Absent → the
   * store stays telemetry-free (existing behavior). */
  telemetry?: Telemetry
}

/** The structural surface the section protocol needs from a settings store
 * (SettingsStore and LayeredSettingsStore both satisfy it). */
export interface SettingsStoreSurface {
  get(): Settings
  isLoaded(): boolean
  load(): Promise<Settings>
  set(patch: Partial<Settings>, guard?: SettingsRevisionGuard): Promise<Settings>
  reset(): Promise<Settings>
  getSectionRevision(name: string): number
  /** Optional unprojected source for stores that expose migrated effective views. */
  getSectionMutationBase?(name: "llm" | "onboarding" | "instructions"): unknown
  /** Optional narrow legacy-plane mutation: drop one `tui.providers` row from
   * the read-pin (see SettingsStore.dropLegacyTuiProvider). */
  dropLegacyTuiProvider?(id: string): Promise<void>
}
