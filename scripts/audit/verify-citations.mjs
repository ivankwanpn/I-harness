#!/usr/bin/env node
// scripts/audit/verify-citations.mjs
//
// Phase 2 adversarial verification of docs/superpowers/specs/
// 2026-09-11-backend-inventory-sevenway-design.md
//
// Design §8 threshold 3 requires a zero forgery rate on a sample of at least 20
// cells. This script does the mechanical half of that check, and it is
// deliberately hostile: every claim in the audit rests on a `path:line` citation
// into someone else's repository, and a citation that does not resolve is either
// a hallucinated path or a stale line number. Both make the matrix lie.
//
// What it CAN prove automatically:
//   - the cited file exists
//   - the cited line number is within the file
//   - the cited line is not blank / not a pure comment
//   - the same line is not cited by many unrelated claims (a tell-tale of a
//     model that picked one plausible-looking line and reused it)
//   - the cited line shares at least one identifier with the claim's own text
//
// What it CANNOT prove: that the cited line actually SUPPORTS the claim. That
// judgement is the job of the sampling pass (`--sample`), which emits the literal
// source lines so a separate verifier agent can rule on them without trusting
// the original extractor's summary.
//
// Usage:
//   node scripts/audit/verify-citations.mjs                 # verify all enriched/raw
//   node scripts/audit/verify-citations.mjs --sample 25     # emit N cells to judge
//   node scripts/audit/verify-citations.mjs --json

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve, relative } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const args = process.argv.slice(2)
const sampleIdx = args.indexOf("--sample")
const SAMPLE_N = sampleIdx >= 0 ? Number(args[sampleIdx + 1]) : 0

/** Source roots, mirroring extract-commands.mjs. */
const SOURCE_PATHS = {
  ih: "D:/I-harness-main",
  dsh: "D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2",
  codex: "D:/agent-complete/codex-rust-v0.149.1",
  opencode: "D:/agent-complete/opencode-1.18.30",
  "opencode-fork": "D:/agent-complete/opencode-fork-private-999.0.15",
  grok: "D:/agent-complete/grok-build-main",
  "cc-custom": "D:/opencode-bugfix/cc-custom",
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

const fileLines = new Map()
function lines(abs) {
  if (fileLines.has(abs)) return fileLines.get(abs)
  let v = null
  try {
    v = readFileSync(abs, "utf8").split(/\r?\n/)
  } catch {
    v = null
  }
  fileLines.set(abs, v)
  return v
}

/** Split "a/b/c.ts:123" into path and line. Bare paths are allowed. */
function parseCitation(cite) {
  const m = String(cite).match(/^(.*?):(\d+)$/)
  if (!m) return { path: String(cite), line: null }
  return { path: m[1], line: Number(m[2]) }
}

/** Identifiers worth comparing between a claim and its cited line. */
function tokens(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_$-]+/)
      .filter((t) => t.length >= 4),
  )
}

const problems = []
const stats = {
  claims: 0,
  citations: 0,
  resolved: 0,
  missingFile: 0,
  outOfRange: 0,
  blank: 0,
  docComment: 0,
  noOverlap: 0,
  noCitation: 0,
}
const lineUse = new Map()
const cells = []
const docOnly = []

function checkClaim(source, cmd, field, claimText, citations) {
  stats.claims++
  if (!citations || citations.length === 0) {
    stats.noCitation++
    problems.push({ source, cmd: cmd.rawName, kind: "NO_CITATION", detail: `${field} has no evidence` })
    return
  }
  const root = SOURCE_PATHS[source]
  const claimTokens = tokens(claimText)
  let anyResolved = false
  let anyCode = false
  for (const cite of citations) {
    stats.citations++
    const { path: rel, line } = parseCitation(cite)
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      stats.missingFile++
      problems.push({ source, cmd: cmd.rawName, kind: "MISSING_FILE", detail: cite })
      continue
    }
    const ls = lines(abs)
    if (!ls) {
      stats.missingFile++
      problems.push({ source, cmd: cmd.rawName, kind: "UNREADABLE", detail: cite })
      continue
    }
    if (line == null) {
      stats.resolved++
      anyResolved = true
      continue
    }
    if (line < 1 || line > ls.length) {
      stats.outOfRange++
      problems.push({ source, cmd: cmd.rawName, kind: "OUT_OF_RANGE", detail: `${cite} (file has ${ls.length} lines)` })
      continue
    }
    const text = ls[line - 1]
    const key = `${source}:${rel}:${line}`
    lineUse.set(key, (lineUse.get(key) ?? 0) + 1)
    const stripped = text.trim()
    // A doc comment is legitimate evidence for a command's NAME (it is often the
    // only place a computed name appears) but never sufficient for a MECHANISM.
    // Counted separately rather than treated as a defect.
    if (/^(\/\/!|\/\/\/|\/\*\*|\*|#)/.test(stripped)) {
      stats.docComment++
      docOnly.push({ source, cmd: cmd.rawName, cite, lineText: stripped.slice(0, 120) })
    } else if (stripped === "") {
      stats.blank++
      problems.push({ source, cmd: cmd.rawName, kind: "BLANK_LINE", detail: cite })
    } else {
      anyCode = true
    }
    // Does the cited line share vocabulary with the claim at all? Weak signal,
    // reported but never treated as a forgery on its own.
    const lineTokens = tokens(stripped)
    let overlap = 0
    for (const t of claimTokens) if (lineTokens.has(t)) overlap++
    if (overlap === 0 && stripped.length > 0) stats.noOverlap++
    stats.resolved++
    anyResolved = true
    cells.push({ source, cmd: cmd.rawName, cite, lineText: stripped, claim: String(claimText ?? "").slice(0, 300), overlap })
  }
  if (!anyResolved) {
    problems.push({ source, cmd: cmd.rawName, kind: "NO_RESOLVABLE_CITATION", detail: `${field}` })
  }
  // A mechanism claim resting ONLY on comments is weak evidence and is reported
  // as such: the audit's whole point is that claims trace to implementation.
  if (field === "mechanism" && anyResolved && !anyCode) {
    problems.push({ source, cmd: cmd.rawName, kind: "COMMENT_ONLY_MECHANISM", detail: `no code line cited for a mechanism claim` })
  }
}

// ------------------------------------------------------------------- run all

const files = readdirSync(DATA).filter((f) => f.endsWith(".json") && !f.includes("-surface"))
for (const f of files) {
  const data = readJson(join(DATA, f))
  if (!data || !data.commands) continue
  const source = data.source
  if (!SOURCE_PATHS[source]) continue
  for (const cmd of data.commands) {
    const claimText = `${cmd.summary ?? ""} ${cmd.mechanism ?? ""}`
    checkClaim(source, cmd, "mechanism", claimText, cmd.evidence)
  }
}

// ---------------------------------------------------------------- reporting

if (SAMPLE_N > 0) {
  // Deterministic sample: stride through the cell list so the sample spreads
  // across sources rather than clustering in whichever file sorting put first.
  const step = Math.max(1, Math.floor(cells.length / SAMPLE_N))
  const picked = []
  for (let i = 0; i < cells.length && picked.length < SAMPLE_N; i += step) picked.push(cells[i])
  console.log(JSON.stringify({ sampleSize: picked.length, ofTotal: cells.length, cells: picked }, null, 2))
} else if (args.includes("--json")) {
  console.log(JSON.stringify({ stats, reusedLines: [...lineUse.entries()].filter(([, n]) => n > 3), problems }, null, 2))
} else {
  console.log("citation verification (mechanical half)")
  console.log("---------------------------------------")
  console.log(`claims examined:        ${stats.claims}`)
  console.log(`citations:              ${stats.citations}`)
  console.log(`  resolved:             ${stats.resolved}`)
  console.log(`  missing file:         ${stats.missingFile}`)
  console.log(`  out of range:         ${stats.outOfRange}`)
  console.log(`  blank line:           ${stats.blank}`)
  console.log(`  doc-comment only:     ${stats.docComment}   (weak but legitimate for a NAME; never for a mechanism)`)
  console.log(`claims with no citation:${String(stats.noCitation).padStart(4)}   <- must be 0`)
  const reused = [...lineUse.entries()].filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1])
  if (reused.length) {
    console.log(`\nlines cited by more than 3 distinct claims (possible lazy citation):`)
    for (const [k, n] of reused.slice(0, 15)) console.log(`  ${String(n).padStart(3)}x  ${k}`)
  }
  if (problems.length) {
    console.log(`\nproblems (${problems.length}), first 30:`)
    for (const p of problems.slice(0, 30)) console.log(`  ${p.kind.padEnd(24)} ${p.source}/${p.cmd}  ${p.detail}`)
  } else {
    console.log("\nno mechanical citation problems found")
  }
}
