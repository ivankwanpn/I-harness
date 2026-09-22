#!/usr/bin/env node
// scripts/audit/ih-gap-report.mjs
//
// Lists every crosswalk row in which I-harness is NOT a member, grouped by domain
// and annotated with who does have the capability. That set is the backend's gap
// list, derived from verified data rather than impression.
//
// Two caveats are printed with the output because both are real and both would
// otherwise make the list look longer than it is:
//   - a row may be ih-less because the capability is filed in ANOTHER of IH's
//     domains, not because IH lacks it;
//   - a row may be ih-less because a composite IH mechanism could only occupy one
//     row.
// Neither is a gap, and the crosswalk authors recorded both.

import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")

const files = readdirSync(DATA).filter((f) => /^2026-09-11-d3-xw-.*\.json$/.test(f) && !f.includes("mechanical"))

const rows = []
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(DATA, f), "utf8"))
  if (!doc.rows) continue
  const domain = doc.domain ?? f.replace(/^2026-09-11-d3-xw-/, "").replace(/\.json$/, "")
  for (const [id, row] of Object.entries(doc.rows)) {
    const members = row.members ?? {}
    const sources = Object.keys(members).filter((k) => (members[k] ?? []).length)
    rows.push({
      domain,
      id,
      label: row.label ?? id,
      sources,
      hasIh: sources.includes("ih"),
      disposition: row.disposition ?? "?",
      rationale: row.rationale ?? "",
      note: row.note ?? row.wiringNote ?? "",
      others: sources.filter((s) => s !== "ih"),
    })
  }
}

const gaps = rows.filter((r) => !r.hasIh)
console.log(`rows total: ${rows.length}   rows where IH is NOT a member: ${gaps.length}\n`)

const byDomain = {}
for (const g of gaps) (byDomain[g.domain] ??= []).push(g)

const ORDER = ["loop", "session", "context", "tools", "subagent", "safety", "model", "extension", "service", "retrieval", "ops", "interface"]
for (const d of ORDER) {
  const list = byDomain[d]
  if (!list?.length) continue
  console.log(`## ${d}  (${list.length})`)
  for (const g of list) {
    const who = g.others.join("+") || "(nobody)"
    console.log(`  [${g.disposition}] ${g.label}`)
    console.log(`        who has it: ${who}`)
    if (g.rationale) console.log(`        why: ${g.rationale}`)
  }
  console.log("")
}

console.log(`dispositions among the gaps: ${JSON.stringify(gaps.reduce((a, g) => ((a[g.disposition] = (a[g.disposition] ?? 0) + 1), a), {}))}`)
console.log(`\nreminder: an ih-less row is not automatically a gap -- see the two caveats in this script's header.`)
