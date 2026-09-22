#!/usr/bin/env node
// scripts/audit/qualify-forkdelta-citations.mjs
//
// A fork delta cites BOTH trees, and the same path can exist in both as DIFFERENT
// files: `packages/core/src/command.ts` is 65 lines upstream and longer in the
// fork. A citation written as `packages/core/src/command.ts:68` therefore does not
// say which tree it means. The prose disambiguates for a human ("upstream
// composes ... whereas the fork exposes ...") but the citation string cannot, and
// a checker has to guess -- which is how the fork's line numbers came to be
// reported as out-of-range against upstream's shorter file.
//
// This qualifies every forkDeltas citation with the tree it actually resolves in,
// prefixing `fork:` or `upstream:`. Where a path resolves in BOTH trees at the
// cited line, the citation is genuinely ambiguous and is reported rather than
// guessed at. Where it resolves in NEITHER, it is a real defect and is reported
// as such.
//
// Usage: node scripts/audit/qualify-forkdelta-citations.mjs [--write]

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const WRITE = process.argv.includes("--write")
const P = join(ROOT, "docs/audit/data/2026-09-11-d3-opencode.json")

const UP = "D:/agent-complete/opencode-1.18.30"
const FORK = "D:/agent-complete/opencode-fork-private-999.0.15"

const doc = JSON.parse(readFileSync(P, "utf8"))
const cache = new Map()
const lineCount = (root, rel) => {
  const k = `${root}|${rel}`
  if (cache.has(k)) return cache.get(k)
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    cache.set(k, null)
    return null
  }
  try {
    const n = readFileSync(abs, "utf8").split(/\r?\n/).length
    cache.set(k, n)
    return n
  } catch {
    cache.set(k, null)
    return null
  }
}

const stats = { qualified: 0, ambiguous: [], neither: [], alreadyQualified: 0 }
const ambiguousRows = []
const neitherRows = []

for (const d of doc.forkDeltas ?? []) {
  d.evidence = (d.evidence ?? []).map((raw) => {
    const s = String(raw)
    if (/^(fork|upstream):/.test(s)) {
      stats.alreadyQualified++
      return s
    }
    const m = s.match(/^(.*?):(\d+)(?:-(\d+))?$/)
    if (!m) {
      stats.neither.push(s)
      return s
    }
    const [, rel, a, b] = m
    const end = b ? Number(b) : Number(a)
    const inFork = (() => {
      const n = lineCount(FORK, rel)
      return n != null && end <= n
    })()
    const inUp = (() => {
      const n = lineCount(UP, rel)
      return n != null && end <= n
    })()
    if (inFork && !inUp) {
      stats.qualified++
      return `fork:${s}`
    }
    if (inUp && !inFork) {
      stats.qualified++
      return `upstream:${s}`
    }
    if (inFork && inUp) {
      ambiguousRows.push({ area: d.area, cite: s })
      return s
    }
    neitherRows.push({ area: d.area, cite: s })
    return s
  })
}

console.log(`forkDeltas citations qualified: ${stats.qualified}`)
console.log(`  already prefixed: ${stats.alreadyQualified}`)
console.log(`  AMBIGUOUS (resolve in BOTH trees at that line): ${ambiguousRows.length}`)
for (const r of ambiguousRows) console.log(`      ${r.area}: ${r.cite}`)
console.log(`  NEITHER tree (citation does not resolve anywhere): ${neitherRows.length}`)
for (const r of neitherRows) console.log(`      ${r.area}: ${r.cite}`)
if (stats.neither.length) {
  console.log(`  unparseable: ${stats.neither.length}`)
  for (const s of stats.neither) console.log(`      ${s}`)
}

if (WRITE) {
  writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
  JSON.parse(readFileSync(P, "utf8"))
  console.log(`\nwrote ${P}`)
} else {
  console.log(`\n(dry run -- pass --write to apply)`)
}
