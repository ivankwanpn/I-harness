#!/usr/bin/env node
// scripts/audit/mechanical-crosswalk.mjs
//
// A DETERMINISTIC FALLBACK crosswalk, for when the twelve per-domain agents do
// not deliver. It groups mechanisms ACROSS sources within a domain by name-token
// overlap, using union-find over a Jaccard threshold.
//
// Be clear about what this is and is not. It is NOT the judgement step the
// crosswalk brief describes: seven independent agents named the same capability
// differently ("append-only shadow projection" vs "rollout-compacted
// projection"), and token overlap cannot recover that. What it CAN do is catch
// the pairs whose names genuinely share vocabulary, and leave everything else as
// single-source rows in the unreconciled appendix -- which is an honest outcome
// and far better than either blocking delivery or claiming seven harnesses share
// nothing.
//
// Every row it emits is marked `_groupedBy: "mechanical"` so the document can
// state plainly that these groupings were not reviewed by a domain agent.
//
// Usage: node scripts/audit/mechanical-crosswalk.mjs [--threshold 0.34] [--out-dir <dir>]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}
const THRESHOLD = Number(arg("--threshold", "0.34"))

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null)

const DOMAINS = readJson(join(DATA, "2026-09-11-d3-domains.json")).domains.map((d) => d.id)

const FILES = {
  ih: "2026-09-11-d3-ih.json",
  dsh: "2026-09-11-d3-dsh.json",
  codex: "2026-09-11-d3-codex.json",
  opencode: "2026-09-11-d3-opencode.json",
  "opencode-fork": "2026-09-11-d3-opencode.json",
  grok: "2026-09-11-d3-grok.json",
  "cc-custom": "2026-09-11-d3-cc-custom.json",
}

/** Collect every mechanism with its source and domain. */
const items = []
for (const [src, file] of Object.entries(FILES)) {
  const doc = readJson(join(DATA, file))
  if (!doc) continue
  const body = src === "opencode" ? doc.upstream : src === "opencode-fork" ? doc.fork : doc
  if (!body?.domains) continue
  for (const [domain, list] of Object.entries(body.domains)) {
    for (const m of list ?? []) items.push({ src, domain, name: m.name, what: m.what ?? "" })
  }
}

/** Tokens worth comparing: drop the generic words every mechanism name shares. */
const STOP = new Set([
  "with", "and", "the", "for", "per", "of", "in", "on", "to", "from", "via", "by",
  "durable", "scoped", "based", "driven", "aware", "level", "mode", "policy", "state",
  "session", "tool", "agent", "model", "provider", "service", "server", "client",
  "context", "event", "events", "store", "storage", "registry", "manager", "runner",
])
const toks = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )
const jaccard = (a, b) => {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
for (const it of items) it.tok = toks(it.name)

// Union-find over pairs in the SAME domain from DIFFERENT sources.
const parent = items.map((_, i) => i)
const find = (x) => {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]]
    x = parent[x]
  }
  return x
}
const union = (a, b) => {
  const ra = find(a)
  const rb = find(b)
  if (ra !== rb) parent[rb] = ra
}

let pairs = 0
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    if (items[i].domain !== items[j].domain) continue
    if (items[i].src === items[j].src) continue // never merge one source into itself
    if (jaccard(items[i].tok, items[j].tok) >= THRESHOLD) {
      union(i, j)
      pairs++
    }
  }
}

const groups = new Map()
items.forEach((it, i) => {
  const r = find(i)
  if (!groups.has(r)) groups.set(r, [])
  groups.get(r).push(it)
})

// Emit one crosswalk file per domain, in the shape assemble-d3 consumes.
const outDir = join(DATA, "d3-xw-mechanical")
mkdirSync(outDir, { recursive: true })
const perDomain = {}
for (const d of DOMAINS) {
  const rows = {}
  let cross = 0
  let single = 0
  for (const [, members] of groups) {
    if (members[0].domain !== d) continue
    const bySrc = {}
    for (const m of members) (bySrc[m.src] ??= []).push(m.name)
    const sources = Object.keys(bySrc)
    if (sources.length > 1) cross++
    else single++
    // Row id must be stable and unique: prefer the ih member's name.
    const id = (bySrc.ih?.[0] ?? members[0].name).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    rows[id] = {
      domain: d,
      label: bySrc.ih?.[0] ?? members[0].name,
      members: bySrc,
      _groupedBy: "mechanical",
    }
  }
  const hasMembers = Object.keys(rows).length > 0
  if (!hasMembers) continue
  perDomain[d] = { rows: Object.keys(rows).length, cross, single }
  writeFileSync(join(outDir, `${d}.json`), JSON.stringify({ domain: d, rows, _groupedBy: "mechanical-token-overlap" }, null, 2) + "\n", "utf8")
}

console.log(`mechanical crosswalk (Jaccard >= ${THRESHOLD}, same domain, different sources)`)
console.log(`  mechanisms: ${items.length}   cross-source groupings formed: ${pairs} pair-merges`)
console.log("  domain        rows  cross  single")
let tr = 0
let tc = 0
for (const [d, s] of Object.entries(perDomain)) {
  console.log(`  ${d.padEnd(12)} ${String(s.rows).padStart(5)} ${String(s.cross).padStart(6)} ${String(s.single).padStart(7)}`)
  tr += s.rows
  tc += s.cross
}
console.log(`  ${"TOTAL".padEnd(12)} ${String(tr).padStart(5)} ${String(tc).padStart(6)}`)
console.log(`\nwrote ${Object.keys(perDomain).length} files to docs/audit/data/d3-xw-mechanical/`)
console.log("These groupings were NOT reviewed by a domain agent. Every row is marked")
console.log("_groupedBy: mechanical, and the document must say so.")
