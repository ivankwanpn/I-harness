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
  return catalog.map((p) => {
    // M49 Task 14 (spec §10.2): the state vocabulary — MOUNTED (installed and
    // enabled), CONFIGURED (installed, not enabled), NOT INSTALLED (catalog
    // shelf only) and FAILED (enable-time command conflicts, D5).
    const state = p.enabled ? "mounted" : p.installed ? "configured" : "not installed"
    const failed = (p.conflicts?.length ?? 0) > 0
      ? ` · failed (${p.conflicts!.length} command conflict${p.conflicts!.length === 1 ? "" : "s"})`
      : ""
    return { label: p.name, detail: `${state}${failed} · ${p.marketplace}` }
  })
}

/** Marketplace view: the not-yet-installed catalog entries (the market shelf). */
export function marketplaceRows(catalog: CatalogPlugin[]): LightPanelRow[] {
  const shelf = catalog.filter((p) => !p.installed)
  if (shelf.length === 0) {
    return [{ label: MARKETPLACE_EMPTY.trim() }]
  }
  return shelf.map((p) => ({ label: p.name, detail: p.marketplace }))
}
