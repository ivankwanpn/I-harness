#!/usr/bin/env node
// scripts/audit/reference-safety-shapes.mjs
//
// Prints how each of the seven sources structures its permission/sandbox layer,
// so a design can be written against what they actually do rather than against
// impressions of what tools like this usually do.
//
// It reads the Phase 1 inventories, not the crosswalk: the crosswalk has already
// collapsed mechanisms into shared rows, which is the right shape for comparing
// PARITY but the wrong shape for seeing how one source is ARCHITECTED.

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const WANT = process.argv[2] ?? "safety"

const FILES = [
  ["ih", "2026-09-11-d3-ih.json"],
  ["dsh", "2026-09-11-d3-dsh.json"],
  ["codex", "2026-09-11-d3-codex.json"],
  ["opencode", "2026-09-11-d3-opencode.json"],
  ["grok", "2026-09-11-d3-grok.json"],
  ["cc-custom", "2026-09-11-d3-cc-custom.json"],
]

const bodies = []
for (const [name, file] of FILES) {
  const p = join(DATA, file)
  if (!existsSync(p)) continue
  const doc = JSON.parse(readFileSync(p, "utf8"))
  if (name === "opencode") {
    if (doc.upstream) bodies.push(["opencode", doc.upstream])
    if (doc.fork) bodies.push(["opencode-fork", doc.fork])
  } else bodies.push([name, doc])
}

for (const [name, body] of bodies) {
  const list = body.domains?.[WANT] ?? []
  console.log(`\n${"=".repeat(72)}\n## ${name}  --  ${list.length} mechanisms in '${WANT}'\n`)
  for (const m of list) {
    const first = (m.evidence ?? [])[0] ?? "(no evidence)"
    console.log(`• ${m.name}`)
    console.log(`  ${String(m.what ?? "").replace(/\s+/g, " ").slice(0, 620)}`)
    if (m.failurePolicy) console.log(`  [failure] ${String(m.failurePolicy).slice(0, 200)}`)
    const consts = (m.constants ?? []).map((c) => `${c.name}=${c.value}`).join("; ")
    if (consts) console.log(`  [constants] ${consts.slice(0, 300)}`)
    console.log(`  [cite] ${first}`)
  }
}
