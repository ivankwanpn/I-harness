#!/usr/bin/env node
// scripts/audit/check-crosswalk-integrity.mjs
//
// Two integrity checks the twelve crosswalk files need before assembly, both
// raised independently by domain agents and neither covered by the assembler.
//
// 1. DUPLICATE MECHANISM PLACEMENT. Phase 1 allowed a mechanism to sit in the
//    domain that fits it best, and two domains can disagree about which that is.
//    The subagent agent placed dsh's `scoped-store-and-event-routing` and
//    `turn-outline-fold` while flagging that they are core/session primitives;
//    the service agent flagged codex's `sandbox-helper-and-arg0-dispatch` as
//    spilling into safety. A mechanism claimed by two domains would appear twice
//    in the matrix, inflating both rows.
//
// 2. CROSS-DOMAIN IH ABSENCE. Because a crosswalk row may only cite mechanisms
//    from its OWN domain, an I-harness capability that lives under another domain
//    cannot be a member — so the row reads as a gap even though IH implements it.
//    The retrieval agent listed four; the extension agent listed eight. Those
//    rows were correctly marked 路線差異, but the document has to say so or a
//    reader will read a filing convention as a capability gap.
//
// Usage: node scripts/audit/check-crosswalk-integrity.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null)

const files = readdirSync(DATA).filter((f) => /^2026-09-11-d3-xw-.*\.json$/.test(f) && !f.includes("mechanical"))

const placements = new Map() // "source::mechanism" -> [{domain,rowId}]
const perDomain = []
let totalRows = 0
let totalMembers = 0

for (const f of files) {
  const doc = readJson(join(DATA, f))
  if (!doc?.rows) continue
  const domain = doc.domain ?? f.replace(/^2026-09-11-d3-xw-/, "").replace(/\.json$/, "")
  let members = 0
  for (const [rowId, row] of Object.entries(doc.rows)) {
    totalRows++
    for (const [src, names] of Object.entries(row.members ?? {})) {
      for (const n of names ?? []) {
        members++
        totalMembers++
        const k = `${src}::${n}`
        if (!placements.has(k)) placements.set(k, [])
        placements.get(k).push({ domain, rowId })
      }
    }
  }
  perDomain.push({ domain, rows: Object.keys(doc.rows).length, members, doubts: (doc.unmergedDoubts ?? []).length })
}

console.log(`crosswalk files: ${files.length}`)
console.log("  domain        rows  members  doubts")
for (const d of perDomain.sort((a, b) => a.domain.localeCompare(b.domain))) {
  console.log(`  ${d.domain.padEnd(12)} ${String(d.rows).padStart(5)} ${String(d.members).padStart(8)} ${String(d.doubts).padStart(7)}`)
}
console.log(`  ${"TOTAL".padEnd(12)} ${String(totalRows).padStart(5)} ${String(totalMembers).padStart(8)}`)

const dupes = [...placements.entries()].filter(([, v]) => v.length > 1)
console.log(`\nCHECK 1 — mechanisms claimed by more than one domain: ${dupes.length}`)
if (dupes.length) {
  for (const [k, v] of dupes) {
    console.log(`  ${k}`)
    console.log(`      ${v.map((x) => `${x.domain}/${x.rowId}`).join("  +  ")}`)
  }
  console.log(`\n  These will appear in TWO rows of the matrix unless one owner is chosen.`)
  console.log(`  The assembler does not detect this; decide per mechanism which domain owns it.`)
} else {
  console.log("  none — every mechanism is claimed by exactly one domain")
}

// CHECK 2: I-harness mechanisms that exist in some source inventory but are not
// a member of any crosswalk row, i.e. they were dropped or live in a domain the
// row does not own. Reported by domain so the document can name them.
const ihDocNames = new Map() // domain -> Set(mechanismName)
{
  const ih = readJson(join(DATA, "2026-09-11-d3-ih.json"))
  for (const [domain, list] of Object.entries(ih?.domains ?? {})) {
    ihDocNames.set(domain, new Set((list ?? []).map((m) => m.name)))
  }
}
const placedIh = new Set([...placements.keys()].filter((k) => k.startsWith("ih::")).map((k) => k.slice(4)))
const unplacedIh = []
for (const [domain, names] of ihDocNames) {
  for (const n of names) if (!placedIh.has(n)) unplacedIh.push(`${domain}/${n}`)
}
console.log(`\nCHECK 2 — IH mechanisms present in the inventory but in NO crosswalk row: ${unplacedIh.length}`)
if (unplacedIh.length) {
  console.log("  (each is either unplaced by its owner, or owned by a domain whose row could not cite it)")
  for (const u of unplacedIh.slice(0, 40)) console.log(`    ${u}`)
  if (unplacedIh.length > 40) console.log(`    … and ${unplacedIh.length - 40} more`)
} else {
  console.log("  none — every IH mechanism is placed somewhere")
}
