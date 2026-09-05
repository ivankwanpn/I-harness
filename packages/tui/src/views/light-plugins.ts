// @i-harness/tui — G2 (M46a): /plugins + /marketplace light panels — the
// plugin-registry catalog (CatalogPlugin[] — installed/enabled flags + the
// marketplace source). Data from @i-harness/plugin-registry PluginRegistry.

import type { CatalogPlugin } from "@i-harness/plugin-registry"
import type { LightPanelRow } from "./light-panel.ts"

export const PLUGINS_EMPTY = "  no plugins installed or cataloged"
export const MARKETPLACE_EMPTY = "  no marketplace sources registered"

export function pluginRows(catalog: CatalogPlugin[]): LightPanelRow[] {
  if (catalog.length === 0) {
    return [{ label: PLUGINS_EMPTY.trim() }]
  }
  return catalog.map((p) => ({
    label: p.name,
    detail: `${p.installed ? (p.enabled ? "enabled" : "installed") : "catalog"} · ${p.marketplace}`,
  }))
}

/** Marketplace view: the not-yet-installed catalog entries (the market shelf). */
export function marketplaceRows(catalog: CatalogPlugin[]): LightPanelRow[] {
  const shelf = catalog.filter((p) => !p.installed)
  if (shelf.length === 0) {
    return [{ label: MARKETPLACE_EMPTY.trim() }]
  }
  return shelf.map((p) => ({ label: p.name, detail: p.marketplace }))
}
