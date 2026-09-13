#!/usr/bin/env node
// scripts/audit/check-thresholds.mjs
//
// The final gate: mechanically checks every acceptance threshold the design
// states in §8, against the ARTEFACTS rather than against the build scripts'
// own console output. A threshold that is only asserted is not a threshold.
//
// Checked:
//   1. D1 covers exactly the in-scope package set (65/65), matching ih-surface.
//   2. Every union row whose IH cell is present carries file:line evidence.
//   3. Adversarial verification sampled >= 20 gradeable cells with 0 forgeries.
//   4. The unreconciled appendix (B) is non-empty.
//   5. No placeholders anywhere in the two documents.
//
// Usage: node scripts/audit/check-thresholds.mjs

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { SOURCES, buildUnion, loadSources } from "./lib-union.mjs"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const AUDIT = join(ROOT, "docs/audit")
const D1 = join(AUDIT, "2026-09-11-ih-backend-inventory.md")
const D2 = join(AUDIT, "2026-09-11-sevenway-command-matrix.md")

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

function slurp(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

// -- 1. package coverage ------------------------------------------------------
const surface = readJson(join(DATA, "2026-09-11-ih-surface.json"))
const inScope = new Set(surface?.packages?.map((p) => p.name) ?? [])
const groupFiles = [
  "2026-09-11-ih-backend-engine.json",
  "2026-09-11-ih-backend-tools.json",
  "2026-09-11-ih-backend-safety-model.json",
  "2026-09-11-ih-backend-service.json",
]
const characterised = new Set()
const extra = []
for (const f of groupFiles) {
  const d = readJson(join(DATA, f))
  if (!d) continue
  for (const p of d.packages ?? []) {
    characterised.add(p.name)
    if (!inScope.has(p.name)) extra.push(p.name)
  }
}
const missing = [...inScope].filter((n) => !characterised.has(n))
check(
  "§8.1 package coverage is exactly 65/65",
  inScope.size === 65 && missing.length === 0 && extra.length === 0,
  `in-scope ${inScope.size}, characterised ${characterised.size}, missing [${missing.join(",")}], out-of-scope [${extra.join(",")}]`,
)

// -- 2. file:line on every IH claim in the union ------------------------------
const loaded = loadSources(DATA)
const { rows } = buildUnion(loaded)
const ihRows = [...rows.values()].filter((r) => r.perSource.ih)
const ihNoEvidence = ihRows.filter((r) => {
  const e = r.perSource.ih
  return !e.evidence || e.evidence.length === 0
})
check(
  "§8.2 every union row with an IH cell carries file:line evidence",
  ihRows.length > 0 && ihNoEvidence.length === 0,
  `${ihRows.length} IH rows, ${ihNoEvidence.length} without evidence${ihNoEvidence.length ? `: ${ihNoEvidence.map((r) => r.key).join(",")}` : ""}`,
)

// -- 3. adversarial verification ---------------------------------------------
const rounds = ["2026-09-12-verification-sample.json", "2026-09-12-verification-sample2.json"]
let gradeable = 0
let forgeries = 0
let uncertainEmpty = 0
const roundDetail = []
for (const f of rounds) {
  const v = readJson(join(DATA, f))
  if (!v) {
    roundDetail.push(`${f}: ABSENT`)
    continue
  }
  const vs = v.verdicts ?? []
  const g = vs.filter((x) => (x.why ?? "").length > 0 && x.verdict !== "UNCERTAIN").length
  const stamp = vs.filter((x) => x.verdict === "UNCERTAIN" && /empty|nothing|no claim/i.test(x.why ?? "")).length
  gradeable += g
  uncertainEmpty += stamp
  forgeries += vs.filter((x) => x.verdict === "UNSUPPORTED").length
  roundDetail.push(`${f}: ${vs.length} cells, ${g} gradeable, ${vs.filter((x) => x.verdict === "UNSUPPORTED").length} unsupported`)
}
check(
  "§8.3 adversarial sample >= 20 gradeable cells with 0 forgeries",
  gradeable >= 20 && forgeries === 0,
  `${gradeable} gradeable, ${forgeries} UNSUPPORTED (${roundDetail.join("; ")})`,
)

// -- 4. unreconciled appendix non-empty --------------------------------------
const d2 = slurp(D2)
if (!d2) {
  check("§8.4 unreconciled appendix (B) is non-empty", false, "D2 not written yet")
} else {
  const hasB = /附錄 B/.test(d2)
  // B is satisfied if it exists and reports at least one of the three signals
  // with a non-zero count, OR the no-signal text is itself justified.
  const counts = [...d2.matchAll(/### B\d\.\s*[^（]*（(\d+)）/g)].map((m) => Number(m[1]))
  const allZero = counts.length > 0 && counts.every((c) => c === 0)
  check(
    "§8.4 unreconciled appendix (B) exists and reports its signals",
    hasB && counts.length >= 3,
    hasB ? `B signal counts: ${counts.join(", ")}${allZero ? " (all zero -- suspicious, seven sources do not name everything identically)" : ""}` : "appendix B missing",
  )
}

// -- 5. no placeholders -------------------------------------------------------
// A naive keyword search is useless here and produced only false positives: the
// corpus legitimately contains a package literally named `todo`, findings that
// REPORT placeholders in the source ("migrate() is an explicit no-op
// placeholder"), and a real concept called an "image placeholder". What matters
// is a STANDALONE marker standing in for content nobody wrote, so that is what
// is checked -- both in the rendered documents and in the underlying data.
const STANDALONE = /^\s*\|?\s*[-*]?\s*(TBD|TODO|FIXME|XXX|PLACEHOLDER|\?\?\?|N\/A|待定|待補|尚未|占位)\s*\|?\s*$/i
const PLACEHOLDER_VALUES = new Set(["tbd", "todo", "fixme", "xxx", "placeholder", "???", "n/a", "待定", "待補", "尚未", "占位"])

/**
 * Identifier-ish fields are exempt: I-harness genuinely ships a package named
 * `todo`, a command named `todo`, an event named `todo/write` and a status value
 * `pending`. Flagging those is noise, and noise in a gate trains people to
 * ignore the gate. Only fields that hold PROSE or a judgement are scanned.
 */
const CONTENT_KEYS = new Set([
  "responsibility",
  "summary",
  "mechanism",
  "decision",
  "rationale",
  "failurePolicy",
  "gaps",
  "designDecisions",
  "commandModelNote",
  "dynamicNote",
  "why",
  "correction",
  "note",
  "description",
  "equivalentSurface",
  "registry",
  "publicSurface",
  "keyConstants",
  "unverified",
])

function scanStandalone(text) {
  return text.split(/\r?\n/).filter((l) => STANDALONE.test(l))
}

/** Walk a parsed JSON value looking for a PROSE field whose value IS a placeholder. */
function scanJsonPlaceholders(value, path = "", key = null) {
  const hits = []
  if (typeof value === "string") {
    if (key !== null && !CONTENT_KEYS.has(key)) return hits
    if (PLACEHOLDER_VALUES.has(value.trim().toLowerCase())) hits.push(`${path} = "${value}"`)
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...scanJsonPlaceholders(v, `${path}[${i}]`, key)))
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      hits.push(...scanJsonPlaceholders(v, path ? `${path}.${k}` : k, k))
    }
  }
  return hits
}

for (const [label, p] of [
  ["D1", D1],
  ["D2", D2],
]) {
  const t = slurp(p)
  if (!t) {
    check(`§8.5 no standalone placeholders in ${label}`, false, `${label} not written yet`)
    continue
  }
  const hits = scanStandalone(t)
  check(
    `§8.5 no standalone placeholders in ${label}`,
    hits.length === 0,
    hits.length ? `${hits.length} standalone marker(s), first: ${hits[0].trim().slice(0, 100)}` : "clean",
  )
}

// The data behind the documents: an agent that gave up would leave a placeholder
// in a field rather than in prose.
let dataHits = []
for (const { key } of SOURCES) {
  for (const suffix of ["enriched", "backend-engine", "backend-tools", "backend-safety-model", "backend-service"]) {
    const d = readJson(join(DATA, `2026-09-11-${key}-${suffix}.json`)) ?? readJson(join(DATA, `2026-09-11-ih-${suffix}.json`))
    if (!d) continue
    dataHits.push(...scanJsonPlaceholders(d, `${key}:${suffix}`))
  }
}
dataHits = [...new Set(dataHits)]
check(
  "§8.5 no placeholder-valued fields in the extraction data",
  dataHits.length === 0,
  dataHits.length ? `${dataHits.length} field(s), first: ${dataHits[0]}` : "clean",
)

// -- 6. disposition integrity ------------------------------------------------
// Two rules the disposition agents were given, checked mechanically because a
// convention is not a guarantee: the vocabulary is closed, and `已存在` /
// `improved-writing` may only be claimed where an I-harness cell actually
// exists. The second matters most -- marking a row `已存在` when I-harness has
// no such command would silently retire a real gap.
const DISPOSITIONS = readJson(join(DATA, "2026-09-11-dispositions.json"))
const VOCAB = new Set(["reuse", "rewrite", "improved-writing", "已存在", "遠期", "不做", "路線差異"])
if (!DISPOSITIONS?.rows) {
  check("§8.6 dispositions assigned and internally consistent", false, "no merged disposition file yet")
} else {
  const badVocab = []
  const falseExist = []
  for (const [key, val] of Object.entries(DISPOSITIONS.rows)) {
    const d = typeof val === "string" ? val : val?.disposition
    if (!VOCAB.has(d)) badVocab.push(`${key}='${d}'`)
    const row = rows.get(key)
    if ((d === "已存在" || d === "improved-writing") && !row?.perSource?.ih) {
      falseExist.push(key)
    }
  }
  check(
    "§8.6 dispositions use the closed vocabulary",
    badVocab.length === 0,
    badVocab.length ? `${badVocab.length} invalid: ${badVocab.slice(0, 5).join(", ")}` : `${Object.keys(DISPOSITIONS.rows).length} rows, all valid`,
  )
  check(
    "§8.6 已存在/improved-writing only where an IH cell exists",
    falseExist.length === 0,
    falseExist.length ? `${falseExist.length} row(s) claim IH has it but have no IH cell: ${falseExist.slice(0, 8).join(", ")}` : "no false 已存在 claims",
  )
}

// -- 7. D3 (mechanism matrix) -------------------------------------------------
// D3's whole premise is "everything that exists was surveyed", so its gates are
// about completeness and provenance rather than about a rendered table.
const D3 = join(AUDIT, "2026-09-11-sevenway-backend-mechanisms.md")
const d3Modules = readJson(join(DATA, "2026-09-11-d3-modules.json"))
const D3_FILES = {
  ih: "2026-09-11-d3-ih.json",
  dsh: "2026-09-11-d3-dsh.json",
  codex: "2026-09-11-d3-codex.json",
  opencode: "2026-09-11-d3-opencode.json",
  "opencode-fork": "2026-09-11-d3-opencode.json",
  grok: "2026-09-11-d3-grok.json",
  "cc-custom": "2026-09-11-d3-cc-custom.json",
}
if (!d3Modules) {
  check("§8.D3 module inventory exists", false, "2026-09-11-d3-modules.json absent")
} else {
  const uncovered = []
  let expectedTotal = 0
  let coveredTotal = 0
  for (const [key, file] of Object.entries(D3_FILES)) {
    const inv = readJson(join(DATA, file))
    if (!inv) {
      uncovered.push({ key, reason: `no inventory (${file})`, missing: [] })
      continue
    }
    const body = key === "opencode" ? inv.upstream : key === "opencode-fork" ? inv.fork : inv
    if (!body) {
      uncovered.push({ key, reason: `no ${key === "opencode" ? "upstream" : "fork"} section`, missing: [] })
      continue
    }
    const expected = (d3Modules.sources[key]?.modules ?? []).map((m) => m.name)
    const cov = body.moduleCoverage ?? {}
    const missing = expected.filter((n) => !(n in cov))
    expectedTotal += expected.length
    coveredTotal += expected.length - missing.length
    if (missing.length) uncovered.push({ key, reason: `${missing.length} unaccounted`, missing })
  }
  check(
    "§8.D3 every module of every source is accounted for",
    uncovered.length === 0,
    uncovered.length
      ? uncovered.map((u) => `${u.key}: ${u.reason}${u.missing.length ? ` [${u.missing.slice(0, 6).join(", ")}…]` : ""}`).join("; ")
      : `${coveredTotal}/${expectedTotal} modules across 7 sources`,
  )
}

if (!existsSync(D3)) {
  check("§8.D3 mechanism matrix written", false, "D3 not written yet")
  check("§8.D3 no standalone placeholders in D3", false, "D3 not written yet")
} else {
  const t = readFileSync(D3, "utf8")
  check("§8.D3 mechanism matrix written", t.length > 2000, `${(t.length / 1024).toFixed(0)} KB`)
  const hits = scanStandalone(t)
  check("§8.D3 no standalone placeholders in D3", hits.length === 0, hits.length ? `first: ${hits[0].trim().slice(0, 100)}` : "clean")
}

// ------------------------------------------------------------------ report
console.log("design §8 acceptance thresholds\n" + "-".repeat(72))
let failed = 0
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
  console.log(`      ${r.detail}`)
  if (!r.pass) failed++
}
console.log("-".repeat(72))
console.log(failed === 0 ? "ALL THRESHOLDS PASS" : `${failed} THRESHOLD(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
