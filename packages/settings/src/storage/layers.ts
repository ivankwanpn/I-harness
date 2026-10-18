import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import { isRecord } from "../normalize/primitives.ts"
import type { LayeredStoreOptions } from "./contracts.ts"

// ── M27 R-E10: layered sources (global < workspace < project, last wins) ─────
// Additive only: SettingsStore / normalizeSettings / resolveSettingsPath keep
// their exact behavior; layering is a NEW family of helpers + a store variant
// built on the same normalize layer.

/** One resolved settings source, lowest → highest priority. */
export interface LayerSource {
  /** Path on disk (null = the source does not exist yet). */
  path: string | null
  /** 0 = lowest, 2 = highest (3+ for extra configured files). */
  order: number
  label: "global" | "workspace" | "project" | "file"
  /** Raw parsed document (comment-stripped), when the source exists. */
  raws?: Record<string, unknown>
}

/** Layered roots: explicit paths, or "auto" (resolved by the store against its
 * configDir/workspace/cwd — see createLayeredStore). */
export interface LayeredRoots {
  global?: string | "auto"
  workspace?: string | "auto"
  project?: string | "auto"
}

const SOURCE_ORDER: Record<string, number> = { global: 0, workspace: 1, project: 2 }

/**
 * Resolve ordered sources from explicit roots (missing files are dropped —
 * a layer without a file contributes nothing). Order: global < workspace <
 * project (project wins).
 */
export function resolveLayeredSources(roots: LayeredRoots): LayerSource[] {
  const sources: LayerSource[] = []
  for (const label of ["global", "workspace", "project"] as const) {
    const configured = roots[label]
    if (configured === undefined) continue
    const path = resolve(configured)
    if (!existsSync(path)) continue // a layer without a file contributes nothing
    sources.push({ path, order: SOURCE_ORDER[label]!, label })
  }
  return sources
}

/** One raw doc contribution to a layer merge (the minimal shape). */
export interface LayerRaw {
  raws?: unknown
}

/** Deep-merge raw layer documents low → high: plain objects merge per key,
 * arrays/scalars are replaced (last wins). The merged RAW is normalized ONCE. */
export function mergeRawLayers(layers: readonly (LayerSource | LayerRaw)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isRecord(layer.raws)) continue
    for (const [key, value] of Object.entries(layer.raws)) {
      out[key] = isRecord(out[key]) && isRecord(value)
        ? mergeRawLayers([{ raws: out[key] }, { raws: value }])
        : value
    }
  }
  return out
}

/** Resolve the layered roots with the store-level defaults: global =
 * `<configDir>/settings.json` (config home, same chain as resolveSettingsPath);
 * workspace = `<workspace>/.i-harness/settings.json`; project =
 * `<cwd>/settings.json`. */
export function resolveLayeredDefaults(options: LayeredStoreOptions): LayerSource[] {
  if (options.files !== undefined) {
    return options.files.map((file, i) => ({ path: resolve(file), order: i, label: "file" as const }))
  }
  const roots = options.roots ?? {}
  const sources: LayerSource[] = []
  const configDir = resolveHarnessHome(options.configDir)
  const workspaceRoot = options.workspace ?? process.cwd()
  if (roots.global !== undefined) {
    const path = roots.global === "auto" ? join(configDir, "settings.json") : resolve(roots.global)
    sources.push({ path, order: 0, label: "global" })
  }
  if (roots.workspace !== undefined) {
    const path = roots.workspace === "auto" ? join(workspaceRoot, ".i-harness", "settings.json") : resolve(roots.workspace)
    sources.push({ path, order: 1, label: "workspace" })
  }
  if (roots.project !== undefined) {
    const path = roots.project === "auto" ? join(process.cwd(), "settings.json") : resolve(roots.project)
    sources.push({ path, order: 2, label: "project" })
  }
  return sources
}
