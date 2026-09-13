#!/usr/bin/env node
// scripts/audit/rebuild-json-from-sections.mjs
//
// Rebuild a structurally damaged JSON document by EXTRACTING its sections and
// re-serialising them, instead of trying to locate the stray brace.
//
// Written for the grok D3 inventory (219 KB, ended at depth -2 with the last
// three top-level keys at depth -1). Brute-forcing brace removals is O(n) per
// candidate and blew up combinatorially; locating the extra brace by hand across
// 1800 lines is slow and error-prone. The CONTENT of that file is intact -- only
// the structure between sections is wrong -- so the reliable repair is to pull
// each section out by string-aware brace matching and emit a fresh document.
//
// Usage: node scripts/audit/rebuild-json-from-sections.mjs <file> [--write]

import { readFileSync, writeFileSync, copyFileSync } from "node:fs"

const file = process.argv[2]
const write = process.argv.includes("--write")
const raw = readFileSync(file, "utf8")

/** Find `"key"` and return the substring of its value, by string-aware matching. */
function extractValue(text, key) {
  const needle = `"${key}"`
  const at = text.indexOf(needle)
  if (at < 0) return null
  let i = text.indexOf(":", at + needle.length)
  if (i < 0) return null
  i++
  while (i < text.length && /\s/.test(text[i])) i++
  const open = text[i]
  const close = open === "{" ? "}" : open === "[" ? "]" : null
  if (!close) return null
  let depth = 0
  let inS = false
  let e = false
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (inS) {
      if (e) {
        e = false
        continue
      }
      if (c === "\\") {
        e = true
        continue
      }
      if (c === '"') inS = false
      continue
    }
    if (c === '"') {
      inS = true
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return text.slice(i, j + 1)
    }
  }
  return null // unbalanced: the section never closes
}

const KEYS = ["source", "sourcePath", "version", "moduleCount", "domains", "moduleCoverage", "hintCorrections", "domainsAbsent"]
const out = {}
const got = []
const missed = []
for (const k of KEYS) {
  const v = extractValue(raw, k)
  if (v === null) {
    missed.push(k)
    continue
  }
  try {
    out[k] = JSON.parse(v)
    got.push(k)
  } catch (err) {
    missed.push(`${k} (${err.message.slice(0, 60)})`)
  }
}

console.log(`recovered sections: ${got.join(", ")}`)
if (missed.length) console.log(`could NOT recover: ${missed.join(", ")}`)

if (!out.domains) {
  console.error("! the domains section is unrecoverable -- nothing to rebuild from")
  process.exit(1)
}

const domains = out.domains

// The damage pattern this file was written for: a mechanism object inside one
// domain array lost its closing brace, so that mechanism's OWN fields
// (invariants, constants, evidence, modules) leak out and appear as if they were
// domains. Filter to the taxonomy's real domains and report what was dropped,
// rather than shipping nonsense domain names into the matrix.
const REAL_DOMAINS = ["loop", "session", "context", "tools", "subagent", "safety", "model", "extension", "service", "retrieval", "ops", "interface"]
const leaked = Object.keys(domains).filter((k) => !REAL_DOMAINS.includes(k))
const clean = {}
for (const d of REAL_DOMAINS) if (Array.isArray(domains[d])) clean[d] = domains[d]
if (leaked.length) {
  console.log(`  LEAKED non-domain keys dropped: ${leaked.join(", ")}`)
  console.log(`  => a mechanism object inside one domain array is missing its closing brace`)
}

// When a domain array's mechanism lost its closing brace, the domains object
// closes EARLY and every later domain ends up nested inside that broken
// mechanism, several indent levels deeper. The content still exists in the raw
// text, so recover each missing domain by extracting it BY NAME rather than by
// position, and report which ones the break actually emptied versus which were
// empty to begin with.
let recovered = []
for (const d of REAL_DOMAINS) {
  if (clean[d]) continue
  const v = extractValue(raw, d)
  if (v === null) continue
  try {
    const arr = JSON.parse(v)
    if (Array.isArray(arr)) {
      clean[d] = arr
      recovered.push(`${d}=${arr.length}`)
    }
  } catch {
    console.log(`  domain '${d}' present but its array is itself damaged -- left out`)
  }
}
if (recovered.length) console.log(`  RECOVERED out-of-place domains: ${recovered.join(" ")}`)
const stillMissing = REAL_DOMAINS.filter((d) => !clean[d])
if (stillMissing.length) console.log(`  genuinely absent after recovery: ${stillMissing.join(", ")}`)

let mechanisms = 0
let noEvidence = 0
const perDomain = []
for (const [d, list] of Object.entries(clean)) {
  perDomain.push(`${d}=${list.length}`)
  mechanisms += list.length
  for (const m of list) if (!Array.isArray(m.evidence) || m.evidence.length === 0) noEvidence++
}
console.log(`  domains: ${Object.keys(clean).length}  mechanisms: ${mechanisms}`)
console.log(`  ${perDomain.join(" ")}`)
console.log(`  mechanisms WITHOUT evidence: ${noEvidence}`)
console.log(`  moduleCoverage entries: ${Object.keys(out.moduleCoverage ?? {}).length}`)
console.log(`  hintCorrections: ${(out.hintCorrections ?? []).length}`)
console.log(`  domainsAbsent: ${(out.domainsAbsent ?? []).length}`)

const rebuilt = {
  source: out.source ?? "grok",
  sourcePath: out.sourcePath ?? "D:/agent-complete/grok-build-main",
  version: out.version ?? "a549186d9d39311f2d3ee4208db62af8c65aa476",
  moduleCount: out.moduleCount ?? 82,
  domains: clean,
  moduleCoverage: out.moduleCoverage ?? {},
  hintCorrections: out.hintCorrections ?? [],
  domainsAbsent: out.domainsAbsent ?? [],
  _rebuiltBy: "scripts/audit/rebuild-json-from-sections.mjs after the assembled file ended at depth -2; a mechanism object inside one domain array was missing its closing brace, which leaked its own fields as domain names",
}

const text = JSON.stringify(rebuilt, null, 2) + "\n"
JSON.parse(text) // sanity
if (write) {
  copyFileSync(file, `${file}.damaged.bak`)
  writeFileSync(file, text, "utf8")
  console.log(`  wrote ${file} (damaged original preserved at ${file}.damaged.bak)`)
} else {
  console.log(`  dry run -- pass --write to apply`)
}
