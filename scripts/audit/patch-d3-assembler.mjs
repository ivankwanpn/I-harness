#!/usr/bin/env node
// scripts/audit/patch-d3-assembler.mjs
//
// Two corrections to assemble-d3.mjs that only became clear once all twelve
// crosswalk files existed.
//
// 1. DISPOSITIONS ARE ALREADY IN THE CROSSWALK ROWS. Each domain agent assigned
//    `disposition` and `rationale` per row, so requiring a separate merged
//    dispositions file is redundant machinery. The assembler now prefers the
//    row's own values and falls back to an external file only if present.
//
// 2. AN EMPTY INVENTORY ARRAY IS NOT AN ABSENCE. Three domain agents (model,
//    service, ops) reported independently that grok's array for their domain is
//    EMPTY -- not because grok lacks the capability, but because its Phase 1
//    inventory emitted no citable mechanisms there, while grok's own
//    moduleCoverage names the modules that do carry it (xai-grok-models,
//    xai-grok-http, xai-grok-telemetry, and so on). Rendering those cells as ✗
//    would publish a false negative, which is the one failure mode this whole
//    audit exists to avoid. A third symbol '?' marks "not inventoried this
//    pass", distinct from ✗ ("has this domain, lacks this mechanism") and —
//    ("has no such layer").
//
// Run once; it edits assemble-d3.mjs in place and is idempotent.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "scripts/audit/assemble-d3.mjs")
let src = readFileSync(P, "utf8")
const before = src

// --- 1. inventory-hole set -------------------------------------------------
if (!src.includes("INVENTORY_HOLES")) {
  src = src.replace(
    "// ------------------------------------------------------------------- crosswalk",
    `// ------------------------------------------------------------------- holes
// (source, domain) pairs whose inventory array is EMPTY while domainsAbsent does
// not declare the domain absent. That combination means "not inventoried this
// pass", NOT "the source lacks the capability" -- measured case: grok's model,
// service and ops arrays are empty, yet grok's own moduleCoverage names
// xai-grok-models, xai-grok-http and xai-grok-telemetry as belonging there.
const INVENTORY_HOLES = new Set()
for (const s of SOURCES) {
  const body = perSource[s.key]
  if (!body) continue
  const absentDomains = new Set((body.domainsAbsent ?? []).map((a) => a.domain ?? a))
  for (const d of DOMAINS) {
    const list = body.domains?.[d]
    if (Array.isArray(list) && list.length === 0 && !absentDomains.has(d)) {
      INVENTORY_HOLES.add(\`\${s.key}::\${d}\`)
    }
  }
}

// ------------------------------------------------------------------- crosswalk`,
  )
}

// --- 2. dispositions from the crosswalk rows ------------------------------
if (!src.includes("row's OWN disposition")) {
  src = src.replace(
    'const dsp = disp[r.id]?.disposition ?? disp[r.id] ?? ""',
    '// The row\'s OWN disposition wins: the domain agent that grouped the row is\n    // the one that judged it, and it recorded the rationale beside it.\n    const dsp = r.disposition ?? disp[r.id]?.disposition ?? disp[r.id] ?? ""',
  )
  src = src.replace(
    'const dr = disp[r.id]?.rationale ? ` — ${esc(disp[r.id].rationale)}` : ""',
    'const dr = r.rationale ? ` — ${esc(r.rationale)}` : disp[r.id]?.rationale ? ` — ${esc(disp[r.id].rationale)}` : ""',
  )
}

// --- 3. the third cell symbol ---------------------------------------------
if (!src.includes('return "?"')) {
  src = src.replace(
    `    const cells = SOURCES.map(({ key }) => {
      const m = r.members[key]
      if (!m) return "✗"
      return "✓"
    })`,
    `    const cells = SOURCES.map(({ key }) => {
      const m = r.members[key]
      if (m) return "✓"
      // Distinguish "this source has the domain but not this mechanism" from
      // "this source's inventory for this domain is empty" -- the latter is a
      // gap in the SURVEY, and rendering it as ✗ would be a false negative.
      if (INVENTORY_HOLES.has(\`\${key}::\${r.domain}\`)) return "?"
      return "✗"
    })`,
  )
}

// --- 4. legend entry for the new symbol -----------------------------------
if (!src.includes("未盤點")) {
  src = src.replace(
    'L.push("| `—` | 該源在此域沒有對應層（見該域的說明） |")',
    'L.push("| `—` | 該源在此域沒有對應層（見該域的說明） |")\nL.push("| `?` | 該源在此域的盤點清單為空——**「本次未盤點」而非「沒有此能力」**（見下方說明） |")',
  )
}

if (src === before) {
  console.log("no changes needed (already patched)")
} else {
  writeFileSync(P, src, "utf8")
  console.log("patched scripts/audit/assemble-d3.mjs")
}
