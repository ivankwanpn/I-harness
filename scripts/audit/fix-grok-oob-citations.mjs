#!/usr/bin/env node
// scripts/audit/fix-grok-oob-citations.mjs
//
// Replaces two out-of-range citations in grok's
// `harness-only-subagent-capability-mode`. They pointed at lines 1828-1832 and
// 1842-1864 of a file that ends well before that, and the mechanism's FIRST
// citation (types.rs:239-305) already covers the range they were trying to
// support -- so they were both wrong and redundant.
//
// The real loci, read from the file: `prune_orphaned_background_task_tools` is
// declared at :256 and `filter_tool_config`'s impl at :290, with
// `allowed_tool_kinds` at :302. The replacements point at those.

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "docs/audit/data/2026-09-11-d3-grok.json")
const doc = JSON.parse(readFileSync(P, "utf8"))

const BAD = [
  "crates/codegen/xai-grok-tools/src/implementations/grok_build/task/types.rs:1828-1832",
  "crates/codegen/xai-grok-tools/src/implementations/grok_build/task/types.rs:1842-1864",
]
const GOOD = [
  "crates/codegen/xai-grok-tools/src/implementations/grok_build/task/types.rs:256-275",
  "crates/codegen/xai-grok-tools/src/implementations/grok_build/task/types.rs:290-305",
]

let fixed = 0
for (const list of Object.values(doc.domains)) {
  for (const m of list ?? []) {
    const before = m.evidence ?? []
    if (!before.some((e) => BAD.includes(e))) continue
    const kept = before.filter((e) => !BAD.includes(e))
    const add = GOOD.filter((g) => !kept.includes(g))
    m.evidence = [...add, ...kept]
    m.citationCorrected = {
      replaced: BAD.filter((b) => before.includes(b)),
      with: add,
      reason:
        "the ranges ran past the end of the file; the declared loci are prune_orphaned_background_task_tools at :256 and filter_tool_config's impl at :290",
      by: "mechanical citation check (2026-09-14)",
    }
    fixed++
    console.log(`fixed ${m.name}: replaced ${BAD.length} out-of-range citation(s)`)
  }
}

if (!fixed) {
  console.log("nothing to fix (already corrected?)")
  process.exit(0)
}
writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
JSON.parse(readFileSync(P, "utf8"))
console.log(`total mechanisms patched: ${fixed}`)
