#!/usr/bin/env node
// scripts/audit/check-d3-source.mjs — validate ONE delivered D3 source inventory
// against the gates that will judge it, without needing all seven present.
//
// Usage: node scripts/audit/check-d3-source.mjs <sourceKey>

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { coverageAccountsFor } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const key = process.argv[2]

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null)

const mods = readJson(join(DATA, "2026-09-11-d3-modules.json"))
const files = {
  ih: "2026-09-11-d3-ih.json",
  dsh: "2026-09-11-d3-dsh.json",
  codex: "2026-09-11-d3-codex.json",
  opencode: "2026-09-11-d3-opencode.json",
  "opencode-fork": "2026-09-11-d3-opencode.json",
  grok: "2026-09-11-d3-grok.json",
  "cc-custom": "2026-09-11-d3-cc-custom.json",
}
if (!key || !files[key]) {
  console.error(`usage: check-d3-source.mjs <${Object.keys(files).join("|")}>`)
  process.exit(2)
}

const doc = readJson(join(DATA, files[key]))
if (!doc) {
  console.log(`${key}: NOT DELIVERED (${files[key]} absent)`)
  process.exit(1)
}
const body = key === "opencode" ? doc.upstream : key === "opencode-fork" ? doc.fork : doc
if (!body) {
  console.log(`${key}: file present but has no ${key === "opencode" ? "upstream" : "fork"} section`)
  process.exit(1)
}

const domains = body.domains ?? {}
let mechanisms = 0
let verified = 0
let noEvidence = 0
const perDomain = []
for (const [d, list] of Object.entries(domains)) {
  perDomain.push(`${d}=${list.length}`)
  for (const m of list) {
    mechanisms++
    if (m.verified === true) verified++
    if (!m.evidence || m.evidence.length === 0) noEvidence++
  }
}

const cov = body.moduleCoverage ?? {}
const expected = (mods.sources[key]?.modules ?? []).map((m) => m.name)
const unaccounted = expected.filter((n) => !coverageAccountsFor(cov, n))
const patterns = Object.keys(cov).filter((k) => k.includes("*"))

console.log(`${key}: ${files[key]}`)
console.log(`  mechanisms        ${mechanisms}  (${perDomain.join(" ")})`)
console.log(`  verified true     ${verified}/${mechanisms}`)
console.log(`  missing evidence  ${noEvidence}   <- must be 0`)
console.log(`  coverage entries  ${Object.keys(cov).length} (${patterns.length} patterns)`)
console.log(`  modules accounted ${expected.length - unaccounted.length}/${expected.length}`)
if (unaccounted.length) {
  console.log(`  UNACCOUNTED (${unaccounted.length}): ${unaccounted.slice(0, 20).join(", ")}${unaccounted.length > 20 ? " …" : ""}`)
}
console.log(`  hintCorrections   ${(body.hintCorrections ?? []).length}`)
console.log(`  domainsAbsent     ${(body.domainsAbsent ?? []).length}`)

const ok = mechanisms > 0 && noEvidence === 0 && unaccounted.length === 0
console.log(ok ? "  => PASSES the gates" : "  => FAILS the gates (would block assembly)")
process.exit(ok ? 0 : 1)
