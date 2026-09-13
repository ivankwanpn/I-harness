#!/usr/bin/env node
// scripts/audit/build-matrix.mjs
//
// Phase 2 of docs/superpowers/specs/2026-09-11-backend-inventory-sevenway-design.md
//
// Unions the seven per-source command extractions into one matrix skeleton. The
// structural step is deliberately NOT an LLM: the union must be reproducible and
// diffable, so that any parity cell in the final document can be regenerated
// rather than argued about. The folding rules live in lib-union.mjs so that this
// script and assemble-d2.mjs cannot drift apart.
//
// Usage: node scripts/audit/build-matrix.mjs [--json]

import { join, resolve, relative } from "node:path"
import { SOURCES, buildUnion, loadSources } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)

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

const loaded = loadSources(DATA)
const missing = SOURCES.filter(({ key }) => !loaded[key]?.enriched && !loaded[key]?.raw).map((s) => s.key)
const { rows, collisions, rejectedAdditions, interactionRows } = buildUnion(loaded)

const allRows = [...rows.values()].sort((a, b) => {
  const fa = FAMILIES.indexOf(a.family)
  const fb = FAMILIES.indexOf(b.family)
  if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
  return a.key.localeCompare(b.key)
})

const counts = {}
for (const { key } of SOURCES) counts[key] = 0
let ihRows = 0
let unverified = 0
let noEvidence = 0

for (const r of allRows) {
  for (const { key } of SOURCES) if (r.perSource[key]) counts[key]++
  if (r.perSource.ih) ihRows++
  for (const v of Object.values(r.perSource)) {
    if (!v.verified) unverified++
    if (!v.evidence || v.evidence.length === 0) noEvidence++
  }
}

const refOnly = allRows.filter((r) => !r.perSource.ih)

if (args.includes("--json")) {
  console.log(JSON.stringify({ rows: allRows, collisions, counts }, null, 2))
} else {
  console.log(`union rows:        ${allRows.length}`)
  console.log(`  with IH column:  ${ihRows}`)
  console.log(`  reference-only:  ${allRows.length - ihRows}   <- capabilities IH has no command for`)
  console.log("")
  console.log("per-source coverage (rows where the source has the command):")
  for (const { key, label } of SOURCES) {
    console.log(`  ${label.padEnd(12)} ${String(counts[key]).padStart(4)}`)
  }
  console.log("")
  console.log(`cells unverified:  ${unverified}`)
  console.log(`cells w/o evidence:${String(noEvidence).padStart(4)}   <- must be 0 before publishing`)
  if (missing.length) console.log(`\nMISSING source data: ${missing.join(", ")}`)

  if (rejectedAdditions.length) {
    console.log(`\nREJECTED \`added\` entries (${rejectedAdditions.length}) -- not command names, so not folded into the union:`)
    for (const r of rejectedAdditions) console.log(`  ${r.source}: ${String(r.value).slice(0, 100)}`)
  }
  if (interactionRows.length) {
    console.log(`\ndsh RPC-plane rows held OUT of the union (${interactionRows.length}) -- a different layer from a slash command; rendered as their own sub-table in D2`)
  }

  if (collisions.length) {
    console.log(`\nsame-source canonical collisions (${collisions.length}) -- both commands re-keyed to their own names:`)
    for (const c of collisions) {
      if (c.unresolved) console.log(`  UNRESOLVED ${c.source}: ${c.names.join(" / ")} both -> '${c.canonical}' and the fallback is taken`)
      else console.log(`  ${c.source}: ${c.names.join(" / ")} were both canonicalised to '${c.canonical}'; kept as '${c.names[0]}' and '${c.displacedTo}'`)
    }
  }

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
      console.log(`  ${r.key.padEnd(28)} ${Object.keys(r.perSource).join(",")}`)
    }
  }
}
