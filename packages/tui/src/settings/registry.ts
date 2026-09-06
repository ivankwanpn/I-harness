// @i-harness/tui — M49 Task 6: the typed settings registry (spec §9.1).
//
// The settings modal is a DECLARATIVE row list instead of a category switch:
// every knob is a SettingDefinition (key + category + value kind + visible +
// read/preview/commit/rollback), the registry filters the fixed eight
// categories by VISIBILITY (a category with zero visible rows is omitted —
// no unavailable-only placeholders), and the modal binder renders whatever
// the registry returns for the browsed category.
//
// Value kinds: boolean / enum / integer / string (secret) / action /
// dynamic-list. The live-application split is the definition's job:
// preview() applies immediately, commit() persists, rollback() restores the
// previous value when the persist fails — the separation the settings
// controller enforces (settings/controller.ts).

import type { SettingsStoreSurface } from "@i-harness/settings"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import type { BackendClient } from "../contracts.ts"

/** The eight spec categories (spec §9.1 — fixed order). A category with no
 * visible row is omitted from the modal (see SettingsRegistry.categories). */
export type SettingsCategory =
  | "Models & Providers"
  | "Appearance"
  | "Editor & Input"
  | "Scrollback & Mouse"
  | "Sessions"
  | "Safety"
  | "Integrations"
  | "Advanced"

export const SETTINGS_CATEGORY_ORDER: readonly SettingsCategory[] = [
  "Models & Providers",
  "Appearance",
  "Editor & Input",
  "Scrollback & Mouse",
  "Sessions",
  "Safety",
  "Integrations",
  "Advanced",
]

/** Capability gate a definition's visible() may consult (no fabrication —
 * `cap` is the host's real capability context). */
export interface SettingsCapabilityContext {
  has(capability: string): boolean
}

/** The per-row execution context (settings store + provider runtime + the
 * live backend — the three write targets the definitions commit through). */
export interface SettingsContext extends SettingsCapabilityContext {
  settings: SettingsStoreSurface
  providers: ProviderRuntime
  backend: BackendClient
}

/** The six value kinds (spec §9.1). `secret` marks a string row that never
 * re-renders its value (empty keeps the current key — provider flow). */
export type SettingValueKind =
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "integer"; min: number; max: number; step: number }
  | { kind: "string"; secret?: boolean }
  | { kind: "action" }
  | { kind: "dynamic-list" }

export interface SettingDefinition {
  key: string
  category: SettingsCategory
  label: string
  description: string
  valueKind: SettingValueKind
  visible(ctx: SettingsCapabilityContext): boolean
  read(ctx: SettingsContext): unknown
  /** Live application — runs immediately; a failed commit rolls back
   * through rollback(). */
  preview?(ctx: SettingsContext, value: unknown): void
  commit(ctx: SettingsContext, value: unknown): Promise<void>
  /** Restore the previewed state when the commit fails (receives the value
   * the row read BEFORE the change). */
  rollback?(ctx: SettingsContext, previous: unknown): void
}

export interface SettingsRegistry {
  /** Visible definitions across all categories (definition order preserved). */
  definitions(): SettingDefinition[]
  /** The categories with at least one visible definition (fixed order). */
  categories(ctx: SettingsCapabilityContext): SettingsCategory[]
  /** The visible rows of one category, in definition order. */
  rows(category: SettingsCategory, ctx: SettingsCapabilityContext): SettingDefinition[]
  /** The first definition with the given key (undefined = unknown row). */
  get(key: string): SettingDefinition | undefined
}

/** Build the typed settings registry: the modal's categories + row inventory
 * filter through `visible`, never through a coded switch. */
export function createSettingsRegistry(defs: readonly SettingDefinition[]): SettingsRegistry {
  const definitions = [...defs]
  return {
    definitions: () => definitions,
    categories(ctx) {
      return SETTINGS_CATEGORY_ORDER.filter((category) => {
        for (const def of definitions) if (def.category === category && def.visible(ctx)) return true
        return false
      })
    },
    rows(category, ctx) {
      return definitions.filter((def) => def.category === category && def.visible(ctx))
    },
    get(key) {
      return definitions.find((def) => def.key === key)
    },
  }
}
