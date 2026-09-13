#!/usr/bin/env node
// scripts/audit/build-matrix.mjs
//
// Phase 2 of docs/superpowers/specs/2026-09-11-backend-inventory-sevenway-design.md
//
// Unions the seven per-source command extractions into one matrix skeleton. The
// structural step is deliberately NOT an LLM: the union must be reproducible and
// diffable, so that any parity cell in the final document can be regenerated
// rather than argued about.
//
// The hard part is §6 crosswalk. Different harnesses name the same capability
// differently (`compact` / `command-compact` / `Compact`), so unioning on the raw
// name would double-count a single capability and make the parity columns lie.
// Two rules keep that honest:
//   1. A name is only merged when a source explicitly claims the mapping
//      (crossSourceHints) or when the normalised names are identical.
//   2. Anything that does not merge stays its own row and is listed in the
//      unreconciled appendix. Coverage is never raised by guessing a mapping.
//
// Usage: node scripts/audit/build-matrix.mjs [--out <file>] [--json]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve, relative } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)

/** Column order of the final matrix: I-harness first (the subject), then refs. */
const SOURCES = [
  { key: "ih", label: "IH" },
  { key: "dsh", label: "dsh" },
  { key: "codex", label: "codex" },
  { key: "opencode", label: "opencode" },
  { key: "opencode-fork", label: "ocode-fork" },
  { key: "grok", label: "grok" },
  { key: "cc-custom", label: "cc-custom" },
]

/** The ten families the matrix is sectioned into (design §4). */
const FAMILIES = [
  "session",
  "context",
  "plan",
  "execution",
  "model",
  "safety",
  "extension",
  "inspect",
  "interface",
  "collab",
]

function slurp(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function readJson(p) {
  const t = slurp(p)
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch (err) {
    console.error(`  ! unparseable JSON: ${relative(ROOT, p)} -- ${err.message}`)
    return null
  }
}

/**
 * Normalise a raw command name to a merge key. Deliberately conservative: only
 * case, separators and the dsh `command-` package prefix are removed. Anything
 * semantic (dropping a verb, singularising) is NOT done here, because that is
 * exactly the kind of guess that would silently merge two different commands.
 */
function norm(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/^command-/, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
}

// ------------------------------------------------------------------ load all

const loaded = {}
const missing = []
for (const { key } of SOURCES) {
  // prefer the enriched file; fall back to the raw extraction so the script is
  // runnable mid-flight (useful for checking the union before agents finish)
  const enriched = readJson(join(DATA, `2026-09-11-${key}-enriched.json`))
  const raw = readJson(join(DATA, `2026-09-11-${key}-commands.json`))
  if (!enriched && !raw) {
    missing.push(key)
    continue
  }
  loaded[key] = { enriched, raw }
}

// ------------------------------------------------------------- build the union

/**
 * Each row: { key, display, family, perSource: { src: entry }, merged: [names] }
 * A source's entries are indexed by merge key, then folded together when a
 * crossSourceHint or an identical normalised name joins them.
 */
const rows = new Map()
const unreconciled = []

function ensureRow(key, family, display) {
  if (!rows.has(key)) {
    rows.set(key, { key, display: display ?? key, family: family ?? null, perSource: {}, merged: [] })
  }
  const r = rows.get(key)
  if (!r.family && family) r.family = family
  return r
}

for (const { key: src } of SOURCES) {
  const bundle = loaded[src]
  if (!bundle) continue
  const list = [...(bundle.enriched?.commands ?? bundle.raw?.commands ?? [])]
  // `added` holds commands the source genuinely has but the mechanical
  // extractor missed. They belong in the union: dropping them silently
  // under-counts the source (dsh would show 3 instead of 6).
  for (const a of bundle.enriched?.added ?? []) {
    if (typeof a === "string") list.push({ rawName: a, canonical: a })
    else if (a && typeof a === "object") list.push(a)
  }
  // dsh's second layer: the interaction commands are real rows too.
  for (const a of bundle.enriched?.interactionCommands ?? []) {
    if (a && typeof a === "object") list.push(a)
  }
  for (const cmd of list) {
    if (!cmd || (!cmd.rawName && !cmd.canonical)) continue
    const primary = norm(cmd.canonical || cmd.rawName)
    // Hints let a source declare "this is really the same thing as X".
    const hints = (cmd.crossSourceHints ?? []).map(norm).filter(Boolean)
    const key = primary
    const row = ensureRow(key, cmd.family ?? null, cmd.canonical || cmd.rawName)
    row.perSource[src] = {
      rawName: cmd.rawName,
      displayName: cmd.displayName ?? cmd.rawName,
      aliases: cmd.aliases ?? [],
      mechanism: cmd.mechanism ?? null,
      gate: cmd.gate ?? null,
      backendModule: cmd.backendModule ?? null,
      backendStatus: cmd.backendStatus ?? null,
      evidence: cmd.evidence ?? [],
      verified: cmd.verified === true,
      summary: cmd.summary ?? null,
    }
    for (const h of hints) {
      if (h === key) continue
      if (!row.merged.includes(h)) row.merged.push(h)
      // A hint pointing at an existing row means the two should be one row.
      const target = rows.get(h)
      if (target && target !== row) {
        for (const [s, v] of Object.entries(target.perSource)) {
          if (!row.perSource[s]) row.perSource[s] = v
        }
        row.merged.push(...target.merged.filter((m) => !row.merged.includes(m)))
        rows.delete(h)
      }
    }
  }
}

// --------------------------------------------------------------- diagnostics

const allRows = [...rows.values()].sort((a, b) => {
  const fa = FAMILIES.indexOf(a.family)
  const fb = FAMILIES.indexOf(b.family)
  if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
  return a.key.localeCompare(b.key)
})

const counts = {}
for (const { key } of SOURCES) counts[key] = 0
let ihRows = 0
let refOnlyRows = 0
let unverified = 0
let noEvidence = 0

for (const r of allRows) {
  for (const { key } of SOURCES) if (r.perSource[key]) counts[key]++
  if (r.perSource.ih) ihRows++
  else refOnlyRows++
  for (const [src, v] of Object.entries(r.perSource)) {
    if (!v.verified) unverified++
    if (!v.evidence || v.evidence.length === 0) noEvidence++
  }
}

// A row present in a reference but absent from IH is the interesting class: it is
// the "someone else can do this and we have no command for it at all" gap.
const refOnly = allRows.filter((r) => !r.perSource.ih)

if (args.includes("--json")) {
  console.log(JSON.stringify({ rows: allRows, unreconciled, counts }, null, 2))
} else {
  console.log(`union rows:        ${allRows.length}`)
  console.log(`  with IH column:  ${ihRows}`)
  console.log(`  reference-only:  ${refOnlyRows}   <- capabilities IH has no command for`)
  console.log("")
  console.log("per-source coverage (rows where the source has the command):")
  for (const { key, label } of SOURCES) {
    console.log(`  ${label.padEnd(12)} ${String(counts[key]).padStart(4)}`)
  }
  console.log("")
  console.log(`cells unverified:  ${unverified}`)
  console.log(`cells w/o evidence:${String(noEvidence).padStart(4)}   <- must be 0 before publishing`)
  if (missing.length) console.log(`\nMISSING source data: ${missing.join(", ")}`)

  const byFamily = {}
  for (const r of allRows) {
    const f = r.family ?? "(unclassified)"
    byFamily[f] = (byFamily[f] ?? 0) + 1
  }
  console.log("\nrows by family:")
  for (const f of [...FAMILIES, "(unclassified)"]) {
    if (byFamily[f]) console.log(`  ${f.padEnd(16)} ${String(byFamily[f]).padStart(4)}`)
  }

  if (refOnly.length) {
    console.log(`\nreference-only rows (first 40 of ${refOnly.length}):`)
    for (const r of refOnly.slice(0, 40)) {
      const who = Object.keys(r.perSource).join(",")
      console.log(`  ${r.key.padEnd(28)} ${who}`)
    }
  }
}
