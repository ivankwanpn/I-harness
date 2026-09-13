#!/usr/bin/env node
// scripts/audit/fix-cc-custom-feature-gate.mjs
//
// Fixes the one D3 verification finding that was genuinely actionable.
//
// The cc-custom `inertMechanisms` entry describing bun:bundle feature gates
// cited `package.json:115-121`, which is the npm scripts block -- a location that
// cannot carry a claim about feature gates. The verifier also found the counts
// LOW: the real figures are 153 importing files, 556 feature() call sites and 68
// distinct flags, against the claimed "~499 call sites, ~70 distinct flags".
//
// A verifier finding that says "your number is wrong" is worth more than one that
// says "your line is wrong", so both are corrected here: the citation moves to a
// real call site and the counts are replaced with the measured ones.

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "docs/audit/data/2026-09-11-d3-cc-custom.json")
const doc = JSON.parse(readFileSync(P, "utf8"))

const list = doc.inertMechanisms ?? []
const target = list.find((m) => typeof m.mechanism === "string" && m.mechanism.includes("bun:bundle"))
if (!target) {
  console.error("! the bun:bundle inertMechanisms entry was not found -- nothing changed")
  process.exit(1)
}

const before = { evidence: [...(target.evidence ?? [])], mechanism: target.mechanism }

// 1. Citation: the cited range was the npm scripts block.
target.evidence = ["src/query/runtime/productionSessionServices.ts:84-86", ...(target.evidence ?? []).filter((e) => !String(e).includes("package.json"))]

// 2. Counts: replace the understated figures with the measured ones and say they
//    were measured, so a later reader does not have to re-derive them.
target.mechanism = target.mechanism
  .replace(/~499 call sites/g, "556 call sites")
  .replace(/~70 distinct flags/g, "68 distinct flags")
  .replace(/All feature\('X'\) gates imported from bun:bundle/, "All feature('X') gates imported from bun:bundle (measured: 153 importing files under src/, 556 feature() call sites, 68 distinct flags)")

target.citationCorrected = {
  was: before.evidence,
  reason:
    "the cited package.json:115-121 is the npm scripts block and cannot carry a feature-gate claim; the counts were also understated (556 call sites over 68 flags in 153 files, not ~499/~70)",
  by: "D3 adversarial verification (2026-09-13)",
}

writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
JSON.parse(readFileSync(P, "utf8"))
console.log("fixed the cc-custom bun:bundle inertMechanisms entry")
console.log(`  evidence: ${before.evidence.join(", ")}`)
console.log(`         -> ${target.evidence.join(", ")}`)
console.log(`  counts:  ~499/~70 -> 556/68 (and marked as measured)`)
