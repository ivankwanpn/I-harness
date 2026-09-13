#!/usr/bin/env node
// scripts/audit/merge-dispositions.mjs
//
// Merges the per-subset disposition files into the single file assemble-d2.mjs
// consumes, and reports every union row that is still unassigned.
//
// The gap report is the point. Dispositions were split across three agents by
// family, and the union grew after they started (176 rows vs the 169 they were
// given), so a silent merge would leave rows with no disposition -- which
// assemble-d2 rejects anyway, but only after the fact and without saying which
// subset dropped them.
//
// Usage: node scripts/audit/merge-dispositions.mjs [--out <file>]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildUnion, loadSources } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const outIdx = process.argv.indexOf("--out")
const OUT = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : join(DATA, "2026-09-11-dispositions.json")

const { rows } = buildUnion(loadSources(DATA))
const unionKeys = new Set([...rows.keys()])

const merged = {}
const provenance = {}
const conflicts = []
const perFile = []

for (const f of readdirSync(DATA).filter((n) => n.startsWith("2026-09-11-dispositions-") && n.endsWith(".json"))) {
  let data
  try {
    data = JSON.parse(readFileSync(join(DATA, f), "utf8"))
  } catch (err) {
    perFile.push({ file: f, error: err.message })
    continue
  }
  const entry = data.rows ?? data
  let n = 0
  for (const [key, val] of Object.entries(entry)) {
    if (key === "subset") continue
    const disposition = typeof val === "string" ? val : val?.disposition
    const rationale = typeof val === "string" ? "" : (val?.rationale ?? "")
    if (!disposition) continue
    if (merged[key] && merged[key].disposition !== disposition) {
      conflicts.push({ key, a: merged[key].disposition, b: disposition, from: f })
      continue
    }
    merged[key] = { disposition, rationale }
    provenance[key] = f
    n++
  }
  perFile.push({ file: f, assigned: n })
}

const assigned = new Set(Object.keys(merged))
const missing = [...unionKeys].filter((k) => !assigned.has(k)).sort()
const orphan = [...assigned].filter((k) => !unionKeys.has(k)).sort()

// Rows the union has but nobody assigned, split by whether I-harness already has
// the command -- which determines whether the answer is a fact (`已存在`) or a
// judgement call.
const missingRows = missing.map((k) => {
  const r = rows.get(k)
  return { key: k, hasIH: Boolean(r?.perSource?.ih), sources: Object.keys(r?.perSource ?? {}) }
})
const missingWithIH = missingRows.filter((r) => r.hasIH)
const missingRefOnly = missingRows.filter((r) => !r.hasIH)

if (missingWithIH.length) {
  // These are mechanical: I-harness demonstrably has the command, so `已存在` is
  // a statement of fact rather than an invented recommendation. Filling them is
  // not a shortcut around judgement -- there is no judgement to make.
  for (const r of missingWithIH) {
    merged[r.key] = { disposition: "已存在", rationale: "IH 已實作（機械補齊）" }
    provenance[r.key] = "(mechanical fill: IH cell present)"
  }
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedBy: "scripts/audit/merge-dispositions.mjs",
      subsets: perFile.filter((p) => !p.error).map((p) => ({ file: p.file, assigned: p.assigned })),
      rows: merged,
    },
    null,
    2,
  ) + "\n",
  "utf8",
)

console.log("disposition merge")
console.log("-".repeat(64))
for (const p of perFile) {
  if (p.error) console.log(`  ERROR  ${p.file}: ${p.error}`)
  else console.log(`  ${String(p.assigned).padStart(4)} rows  ${p.file}`)
}
console.log(`\nunion rows:        ${unionKeys.size}`)
console.log(`assigned:          ${assigned.size}`)
console.log(`mechanically filled (IH cell present): ${missingWithIH.length}`)
console.log(`STILL MISSING (reference-only, needs judgement): ${missingRefOnly.length}`)
if (missingRefOnly.length) {
  console.log(`\n  ${missingRefOnly.map((r) => `${r.key}[${r.sources.join(",")}]`).join("\n  ")}`)
}
if (orphan.length) {
  console.log(`\nassigned but not in the union (${orphan.length}): ${orphan.join(", ")}`)
}
if (conflicts.length) {
  console.log(`\nCONFLICTS (${conflicts.length}):`)
  for (const c of conflicts) console.log(`  ${c.key}: '${c.a}' vs '${c.b}' (${c.from})`)
}
console.log(`\nwrote ${OUT}`)
process.exit(missingRefOnly.length === 0 && conflicts.length === 0 ? 0 : 1)
