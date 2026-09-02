/**
 * Models wire view (merge part of the models plan): the pure folds behind
 * GET /api/llm/directory + GET /api/models/catalog — the SPA composer's model
 * selection list.
 *
 * Directory merge rules (T3 — the runtime directory is the registry AND the
 * user's section extends it; amendment: the CLI's registry is composed EMPTY,
 * so rows = user-section routes):
 * - rows = describeDirectory() rows (declared: true — embedder-registered
 *   profiles only now; the default composition has none) ⊕ the user-section
 *   routes (llm.providers keys — declared: false, user: true), each
 *   {route, displayName?, protocol?, defaultApiKeyEnv?, models[]} with BOTH
 *   provenance marks. The `declared` field stays on the wire for shape
 *   stability (always false under the amendment's default composition). The
 *   user's section `llm.providers.<route>.models` list EXTENDS a declared row
 *   (ids not already listed are appended, deduped — the declared row WINS
 *   each id collision, name included; user model OBJECTS keep their
 *   name/contextWindow/maxTokens on the wire).
 * - every row's `protocol` is the RESOLVED wire protocol (resolveProviderProtocol
 *   chain: user > SEEDED_PROTOCOLS[route] > DEFAULT) so the SPA always sees a
 *   valid one of the three — the same vocabulary T2 probe / T4 dispatch use.
 * - catalog failures = user-section routes whose RAW protocol is not one of the
 *   three → {route, reason: "unknown-protocol"} (defense-in-depth — T1's
 *   mutate rejects unknown values and normalize drops them at read; this gates
 *   a raw/old view source). An unusable route is a failure, never a group.
 * - default = the section view's `llm.defaultModel` (the describeSection
 *   projection — redacted MERGED view); it falls back to the store's
 *   normalized default when the view's value is empty (describeSection can
 *   produce `{}` for a section the store never persisted). Under the amendment
 *   that default is the honest UNSET {provider:"",model:""} — the SPA seat
 *   renders 未配置.
 *
 * Pure module: no fs, no host transport — the routes own those (goal.ts
 * precedent: host.ts calls the folds, this file owns the shape).
 *
 * @module @i-harness/web-host/models
 */

import type { DirectoryEntry, ModelDescriptor } from "@i-harness/provider"
import {
  PROVIDER_PROTOCOLS,
  resolveProviderProtocol,
  type SectionView,
  type SettingsModel,
  type SettingsProviderConfig,
  type SettingsProviderProtocol,
} from "@i-harness/settings"

export interface CatalogDefault {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Catalog model row — the registry's ModelDescriptor (id + name + caps; the
 * objectified T3 wire). One source of truth, no drift. */
export type CatalogModel = ModelDescriptor

export interface CatalogGroup {
  route: string
  displayName: string
  models: CatalogModel[]
}

export interface CatalogFailure {
  route: string
  reason: string
}

/** Wire view of GET /api/models/catalog. */
export interface ModelsCatalogView {
  default: CatalogDefault
  groups: CatalogGroup[]
  failures: CatalogFailure[]
}

/**
 * One row of the MERGED runtime directory (GET /api/llm/directory): the
 * provider registry's declared rows ⊕ the user-section routes — one row
 * per route regardless of provenance. `declared` = the registry registered it
 * (embedder-composed profiles only — the amendment's default registry is
 * EMPTY, so in the default composition every row has declared: false);
 * `user` = the user's llm.providers section carries the key.
 */
export interface ProviderDirectoryRow {
  route: string
  displayName?: string
  /** The route's effective wire protocol — resolveProviderProtocol's chain
   * (user section value > SEEDED_PROTOCOLS[route] > DEFAULT): always one of
   * the three wire values. */
  protocol?: SettingsProviderProtocol
  defaultApiKeyEnv?: string
  /** The seed profile's default model (declared rows only). */
  defaultModel?: string
  /** Merged model rows: declared first, then the user's model objects
   * (id-deduped — the declared row wins a collision, name and caps preserved). */
  models?: ModelDescriptor[]
  /** The provider registry registered this route (a seed profile). */
  declared: boolean
  /** The user's llm.providers section carries this route key. */
  user: boolean
}

/** The user-section arm of a merged directory row: a route that exists ONLY in
 * the user's llm.providers section (never seed-registered). */
export interface UserProviderView extends ProviderDirectoryRow {
  declared: false
  user: true
}

export const UNKNOWN_PROTOCOL_REASON = "unknown-protocol"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWireProtocol(value: unknown): value is SettingsProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/** The section view's USER layer — the actually-stored llm.providers map (the
 * merged `value` layer is user-only since the amendment: the sections
 * package's base providers map is EMPTY, so there is no non-user config that
 * could ever leak into rows or failures). */
export function sectionUserProviders(section: SectionView): Record<string, unknown> {
  const user = section.user
  return user !== undefined && isRecord(user.providers) ? user.providers : {}
}

/** The user's stored config for one route in the settings chain's shape (the
 * redacted view is structural — the cast never invents fields). */
function userConfigOf(raw: unknown): SettingsProviderConfig | undefined {
  return isRecord(raw) ? (raw as SettingsProviderConfig) : undefined
}

/** One user model row (T1 objects {id, name?, contextWindow?, maxTokens?});
 * string entries (a raw/old-format view) degrade to {id} defensively; junk
 * dropped. */
function userModelOf(raw: unknown): ModelDescriptor | undefined {
  if (typeof raw === "string" && raw !== "") return { id: raw }
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return undefined
  const out: ModelDescriptor = { id: raw.id }
  if (typeof raw.name === "string" && raw.name !== "") out.name = raw.name
  if (isPositiveInteger(raw.contextWindow)) out.contextWindow = raw.contextWindow
  if (isPositiveInteger(raw.maxTokens)) out.maxTokens = raw.maxTokens
  return out
}

function userModelDescriptors(raw: unknown): ModelDescriptor[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const models = raw.flatMap((m): ModelDescriptor[] => {
    const row = userModelOf(m)
    return row !== undefined ? [row] : []
  })
  return models.length > 0 ? models : undefined
}

/** Declared models first (each id wins once, with the declared row's metadata);
 * the user's extra model objects are appended with their own name/caps. */
export function mergeCatalogModels(
  directory: ModelDescriptor[],
  user: ModelDescriptor[],
): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const m of directory) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  for (const m of user) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

/**
 * probe-apply upsert (spec §2.2): discovered rows are merged into the section's
 * existing model list BY ID — an existing id is overwritten in place (name and
 * caps follow the discovered row), a new id is appended, and NO existing row is
 * ever deleted (deletion stays a user action). Pure — the route feeds the
 * merged list to mutateSection; a section store without the route yet starts
 * from the empty list (the ops write `providers.<route>.models`, materializing
 * the route row with models only — baseURL/protocol/keys stay compose-side).
 */
export function upsertModelRows(existing: SettingsModel[] | undefined, discovered: ModelDescriptor[]): SettingsModel[] {
  const out: SettingsModel[] = existing !== undefined ? [...existing] : []
  const indexById = new Map(out.map((m, i) => [m.id, i] as const))
  for (const row of discovered) {
    const idx = indexById.get(row.id)
    const entry: SettingsModel = { id: row.id }
    if (row.name !== undefined) entry.name = row.name
    if (row.contextWindow !== undefined) entry.contextWindow = row.contextWindow
    if (row.maxTokens !== undefined) entry.maxTokens = row.maxTokens
    if (idx !== undefined) {
      out[idx] = entry
    } else {
      indexById.set(row.id, out.length)
      out.push(entry)
    }
  }
  return out
}

/** The declared ⊕ user model rows of one directory row (omitted when empty). */
function mergedModelRows(
  declared: ModelDescriptor[] | undefined,
  userRaw: unknown,
): ModelDescriptor[] | undefined {
  const merged = mergeCatalogModels(declared ?? [], userModelDescriptors(userRaw) ?? [])
  return merged.length > 0 ? merged : undefined
}

/**
 * The merged runtime directory: the registry's declared seed rows ⊕ the
 * user-section routes (llm.providers keys). A declared route the user also
 * configured stays ONE row (both marks true — the declared content wins, the
 * user's model objects extend); a section-only route becomes a new row
 * (declared: false, user: true). Every row's protocol is the resolved wire
 * protocol (user > seeded > default) — the SPA never resolves routes itself.
 * @param directory      describeDirectory() rows (the T3 authoritative runtime registry).
 * @param userProviders  the section view's USER-layer providers (redacted).
 */
export function mergeDirectoryRows(
  directory: DirectoryEntry[],
  userProviders: Record<string, unknown>,
): ProviderDirectoryRow[] {
  const declaredRoutes = new Set(directory.map((row) => row.route))
  const rows: ProviderDirectoryRow[] = directory.map((row) => {
    const cfg = userConfigOf(userProviders[row.route])
    const models = mergedModelRows(row.models, cfg?.models)
    return {
      route: row.route,
      displayName: row.displayName,
      protocol: resolveProviderProtocol(row.route, cfg),
      ...(row.defaultApiKeyEnv !== undefined ? { defaultApiKeyEnv: row.defaultApiKeyEnv } : {}),
      ...(row.defaultModel !== undefined ? { defaultModel: row.defaultModel } : {}),
      ...(models !== undefined ? { models } : {}),
      declared: true,
      user: cfg !== undefined,
    }
  })
  for (const route of Object.keys(userProviders).filter((r) => !declaredRoutes.has(r)).sort()) {
    const cfg = userConfigOf(userProviders[route])
    const models = userModelDescriptors(cfg?.models)
    const row: UserProviderView = {
      route,
      protocol: resolveProviderProtocol(route, cfg),
      ...(typeof cfg?.displayName === "string" && cfg.displayName !== "" ? { displayName: cfg.displayName } : {}),
      ...(typeof cfg?.apiKeyEnv === "string" && cfg.apiKeyEnv !== "" ? { defaultApiKeyEnv: cfg.apiKeyEnv } : {}),
      ...(models !== undefined ? { models } : {}),
      declared: false,
      user: true,
    }
    rows.push(row)
  }
  return rows
}

/** The section view's llm.defaultModel (redacted); empty → the normalized default. */
export function catalogDefaultOf(
  section: SectionView,
  fallback: CatalogDefault,
): CatalogDefault {
  const raw = section.value.defaultModel
  if (isRecord(raw)
    && typeof raw.provider === "string" && raw.provider !== ""
    && typeof raw.model === "string" && raw.model !== "") {
    return {
      provider: raw.provider,
      model: raw.model,
      ...(typeof raw.reasoningEffort === "string" && raw.reasoningEffort !== ""
        ? { reasoningEffort: raw.reasoningEffort }
        : {}),
    }
  }
  return {
    provider: fallback.provider,
    model: fallback.model,
    ...(fallback.reasoningEffort !== undefined ? { reasoningEffort: fallback.reasoningEffort } : {}),
  }
}

/**
 * Build the catalog view from the merged directory (declared ⊕ user section).
 * @param input.directory       describeDirectory() rows (seeded registry truth).
 * @param input.section         describeSection("llm") — its VALUE carries the
 *                              redacted merged providers ⊕ defaultModel; the
 *                              USER layer the actually-stored config.
 * @param input.fallbackDefault the normalized Settings.defaultModel (a loaded
 *                              SettingsStore always carries complete defaults
 *                              — the section value's empty-object escape hatch).
 */
export function buildModelsCatalog(input: {
  directory: DirectoryEntry[]
  section: SectionView
  fallbackDefault: CatalogDefault
}): ModelsCatalogView {
  const userLayer = sectionUserProviders(input.section)
  const rows = mergeDirectoryRows(input.directory, userLayer)
  const groups: CatalogGroup[] = []
  const failures: CatalogFailure[] = []
  for (const row of rows) {
    const rawProtocol = userConfigOf(userLayer[row.route])?.protocol
    if (row.user && rawProtocol !== undefined && !isWireProtocol(rawProtocol)) {
      // Defense-in-depth: T1's mutate fails loud on unknown protocol values
      // (normalize drops them at read) — an unusable route fails, never a group.
      failures.push({ route: row.route, reason: UNKNOWN_PROTOCOL_REASON })
      continue
    }
    // T6-Minor(a): the group header is USER-WINS — the same rule the section
    // rows/dialogs use (cfg.displayName ?? row.displayName); a declared route
    // the user also configured shows the USER's displayName, never the seed's.
    const cfg = userConfigOf(userLayer[row.route])
    const name = (typeof cfg?.displayName === "string" && cfg.displayName !== "" ? cfg.displayName : undefined)
      ?? row.displayName
      ?? row.route
    groups.push({
      route: row.route,
      displayName: name,
      models: row.models ?? [],
    })
  }
  return {
    default: catalogDefaultOf(input.section, input.fallbackDefault),
    groups,
    failures,
  }
}
