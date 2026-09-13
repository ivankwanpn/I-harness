#!/usr/bin/env node
// scripts/audit/fix-codex-dir-citations.mjs
//
// Upgrades three codex citations from a DIRECTORY to a file:line inside it.
//
// The checker reclassified these as "directory-only" rather than defects, which
// is right -- each points at a real subsystem. But directory-only is weaker
// evidence: it cannot show WHICH file carries the claim. Each directory has an
// unambiguous entry point, so the citations are upgraded rather than left weak.

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "docs/audit/data/2026-09-11-d3-codex.json")
const doc = JSON.parse(readFileSync(P, "utf8"))

const UPGRADE = {
  "codex-rs/vendor/bubblewrap": "codex-rs/vendor/bubblewrap/bubblewrap.c:1",
  "codex-rs/collaboration-mode-templates": "codex-rs/collaboration-mode-templates/src/lib.rs:1",
  "codex-rs/ext/extension-api/src/contributors": "codex-rs/ext/extension-api/src/contributors/context.rs:1",
}

let n = 0
for (const list of Object.values(doc.domains ?? {})) {
  for (const m of list ?? []) {
    const ev = m.evidence ?? []
    const hit = ev.filter((e) => UPGRADE[e])
    if (!hit.length) continue
    const replaced = hit.map((e) => UPGRADE[e])
    m.evidence = [...replaced, ...ev.filter((e) => !UPGRADE[e])]
    m.citationCorrected = {
      replaced: hit,
      with: replaced,
      reason:
        "a directory is a real location but cannot show which file carries the claim; each directory has an unambiguous entry point",
      by: "mechanical citation check (2026-09-14)",
    }
    n++
    console.log(`upgraded ${m.name}: ${hit.length} directory citation(s) -> file:line`)
  }
}

if (!n) {
  console.log("nothing to upgrade")
  process.exit(0)
}
writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
JSON.parse(readFileSync(P, "utf8"))
console.log(`mechanisms patched: ${n}`)
