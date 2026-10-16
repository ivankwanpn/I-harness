import { MODEL_CATALOG, MODEL_CATALOG_LOADED, type ModelCard, type ModelCatalogProvenance, type ModelCatalogRow } from "./load.ts"

/** Pure catalog query: the card for one model in one card FAMILY, or undefined
 * when the table has no entry (fail-closed — never a synthetic value).
 *
 * `family` is the DECLARED card family (`ProviderProfile.catalog`), which
 * defaults to the route name — see that field for why it is not the route
 * itself. */
export function resolveModelCard(family: string, modelId: string): ModelCard | undefined {
  const card = MODEL_CATALOG[family]?.[modelId]
  return card === undefined ? undefined : { ...card }
}

/** The table's provenance: when its numbers were last revised, and the source
 * each family declares. Read by `i-harness provider list`, which prints it — a
 * table whose age cannot be read is a table nobody knows to update. */
export function resolveModelCatalogProvenance(): ModelCatalogProvenance {
  return {
    generatedAt: MODEL_CATALOG_LOADED.provenance.generatedAt,
    families: MODEL_CATALOG_LOADED.provenance.families.map((entry) => ({ ...entry })),
  }
}

/** One family's rows IN FILE ORDER, each with the aliases that also resolve to
 * it. An unknown family lists nothing — the same fail-closed answer
 * `resolveModelCard` gives, so a caller can render a miss without a special
 * case. Copies: the loaded table is not a caller's to edit. */
export function listModelCatalogFamily(family: string): ModelCatalogRow[] {
  const rows = MODEL_CATALOG_LOADED.rows[family]
  if (rows === undefined) return []
  return rows.map((row) => ({ modelId: row.modelId, aliases: [...row.aliases], card: { ...row.card } }))
}
