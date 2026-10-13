import { readFileSync } from "node:fs"
import { positiveInteger } from "../values.ts"

// ── M32 T1: model cards (capability cards, NOT a directory) ──────────────────
// model-catalog.json is a DATA FILE of per-model capability cards
// ({ contextWindow, maxOutputTokens }) — the last arm of the unified
// resolution chain (userModel > modelContexts > profile > CARD > undefined).
// Capability semantics: the model's documented limits. SUPERSEDED BY M72 Ⅱ
// (spec §1.1) — this block used to read "display/validation only; NO request
// default is ever derived from a card ('缺省不發' — the absence stance); a
// request maxTokens ABOVE the card is fail-loud at the model end (no
// clamping)". The card's `maxOutputTokens` IS now the SECOND source of a
// request's output cap (the user's own row is the first), so the resolution
// below feeds a REQUEST and not only a display; the clamp against what the
// request has left lives in core-agent (one place, next to the window).
//
// D3 (2026-09-19): the file is `{ generatedAt, families }`, and it now carries
// WHERE ITS NUMBERS CAME FROM. Two properties are ENFORCED by the loader below
// rather than promised by a comment — both because this table is
// hand-maintained and both failure modes were observed, not imagined:
//   - every family must declare a `source`. The numbers used to be annotated
//     HERE, in code, and the table itself carried no provenance at all; a
//     retired model name sat in it unnoticed because nothing in the FILE said
//     what the file was supposed to contain (design §1.2).
//   - a retired name is an ALIAS on the current row, not a second row. Two
//     rows holding one model's numbers are two places to edit, and only one of
//     them gets edited.
// `generatedAt` is the date the NUMBERS were last revised. The file is
// hand-maintained, so this is a revision date, NOT a generation timestamp —
// Pi's manifest, where this field comes from, is written by a generator we do
// not have. Deliberately NOT copied from it: the per-file sha256, which guards
// a remote overlay against downgrading a release. We have no remote and no
// generator, so a hash of a file stored in that file would be decoration.
type ModelCatalog = Record<string, Record<string, { contextWindow?: number; maxOutputTokens?: number }>>

/** One capability card (model-documented limits). */
export interface ModelCard {
  contextWindow?: number
  maxOutputTokens?: number
}

/** One row of the table as WRITTEN: the row's own name, its retired names, and
 * the card they share. */
export interface ModelCatalogRow {
  modelId: string
  aliases: string[]
  card: ModelCard
}

/** Where one family's numbers came from. */
export interface ModelCatalogFamilySource {
  family: string
  source: string
}

/** The table's own provenance — the answer to "how old is this, and who says?". */
export interface ModelCatalogProvenance {
  /** The date the numbers were last revised (YYYY-MM-DD). */
  generatedAt: string
  families: ModelCatalogFamilySource[]
}

const CATALOG_FILE = "provider: model-catalog.json"

/** `aliases` is optional; an EMPTY array is refused rather than tolerated,
 * because writing one is a statement ("this row has aliases") that says
 * nothing, and the next reader has to check. */
function parseAliases(value: unknown, family: string, modelId: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${CATALOG_FILE} ${family}.${modelId} aliases must be a non-empty array of names`)
  }
  return value.map((alias) => {
    if (typeof alias !== "string" || alias.trim() === "") {
      throw new Error(`${CATALOG_FILE} ${family}.${modelId} has an empty alias`)
    }
    if (alias === modelId) {
      throw new Error(`${CATALOG_FILE} ${family}.${modelId} lists itself as an alias`)
    }
    return alias
  })
}

function loadModelCatalog(): {
  catalog: ModelCatalog
  rows: Record<string, ModelCatalogRow[]>
  provenance: ModelCatalogProvenance
} {
  const text = readFileSync(new URL("../model-catalog.json", import.meta.url), "utf8")
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CATALOG_FILE} is not an object`)
  }
  const root = parsed as Record<string, unknown>
  const generatedAt = root.generatedAt
  // Validated as a date, not merely required: a provenance field holding
  // whatever anyone typed is a field nobody can act on.
  if (typeof generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(generatedAt)) {
    throw new Error(`${CATALOG_FILE} generatedAt must be a YYYY-MM-DD date`)
  }
  const families = root.families
  if (typeof families !== "object" || families === null || Array.isArray(families)) {
    throw new Error(`${CATALOG_FILE} families is not an object`)
  }

  const catalog: ModelCatalog = {}
  const rowsByFamily: Record<string, ModelCatalogRow[]> = {}
  const provenance: ModelCatalogProvenance = { generatedAt, families: [] }
  for (const [family, body] of Object.entries(families as Record<string, unknown>)) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(`${CATALOG_FILE} family "${family}" is not an object`)
    }
    const { source, models } = body as Record<string, unknown>
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error(`${CATALOG_FILE} family "${family}" declares no source`)
    }
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      throw new Error(`${CATALOG_FILE} family "${family}" has no models object`)
    }

    const lookup: Record<string, ModelCard> = {}
    const rows: ModelCatalogRow[] = []
    /** Every name this family has claimed → the row that claimed it. */
    const claimed = new Map<string, string>()
    for (const [modelId, card] of Object.entries(models as Record<string, unknown>)) {
      if (typeof card !== "object" || card === null || Array.isArray(card)) {
        throw new Error(`${CATALOG_FILE} ${family}.${modelId} is not an object`)
      }
      const row = card as Record<string, unknown>
      const contextWindow = positiveInteger(row.contextWindow)
      const maxOutputTokens = positiveInteger(row.maxOutputTokens)
      if (contextWindow === undefined && maxOutputTokens === undefined) {
        throw new Error(`${CATALOG_FILE} ${family}.${modelId} has no positive-integer capability`)
      }
      const aliases = parseAliases(row.aliases, family, modelId)
      // An id claimed twice is ambiguous, and these names are aliases precisely
      // because they are ONE model — a second row claiming the same name
      // rebuilds the drift this shape exists to prevent.
      for (const name of [modelId, ...aliases]) {
        const owner = claimed.get(name)
        if (owner !== undefined) {
          throw new Error(`${CATALOG_FILE} ${family}: "${name}" is claimed by both ${owner} and ${modelId}`)
        }
        claimed.set(name, modelId)
      }
      const entry: ModelCard = {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      }
      lookup[modelId] = entry
      // The alias resolves to the SAME card OBJECT, not a copy of its numbers:
      // one row to edit, so the current name and the retired one cannot drift.
      // (resolveModelCard copies on the way out, so callers still cannot reach
      // this object.)
      for (const alias of aliases) lookup[alias] = entry
      rows.push({ modelId, aliases, card: entry })
    }
    catalog[family] = lookup
    rowsByFamily[family] = rows
    provenance.families.push({ family, source })
  }
  return { catalog, rows: rowsByFamily, provenance }
}

export const MODEL_CATALOG_LOADED = loadModelCatalog()

export const MODEL_CATALOG: ModelCatalog = MODEL_CATALOG_LOADED.catalog
