import type { Telemetry } from "@i-harness/telemetry"
import type { Settings } from "../schema/types.ts"
import type { LayeredRoots } from "./layers.ts"

export interface SettingsStoreOptions {
  /** Document path; defaults to `<configDir>/settings.json` (see defaultSettingsPath). */
  path?: string
  /** Config home used when `path` is omitted; defaults to `$IH_CONFIG_DIR` or `~/.i-harness`. */
  configDir?: string
}

export interface LayeredStoreOptions {
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
  /** WHY: preserve the existing option (test/watch.test.ts:51) while
   * detection is event-driven. A number sets watcher-error retry delay
   * (default 500ms); `false` disables watching entirely. */
  watchIntervalMs?: number | false
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
  set(patch: Partial<Settings>): Promise<Settings>
  reset(): Promise<Settings>
  getSectionRevision(name: string): number
  /** Optional unprojected source for stores that expose migrated effective views. */
  getSectionMutationBase?(name: "llm" | "onboarding"): unknown
  /** Optional narrow legacy-plane mutation: drop one `tui.providers` row from
   * the read-pin (see SettingsStore.dropLegacyTuiProvider). */
  dropLegacyTuiProvider?(id: string): Promise<void>
}
