#!/usr/bin/env node
// scripts/audit/compare-fork-branches.mjs
//
// Works out whether the opencode-fork column of D3 can be reproduced from what
// GitHub actually serves, and from which branch.
//
// Why this exists: the local fork checkout is `D:\agent-complete\
// opencode-fork-private-999.0.15`, a clone whose HEAD sits on branch 999.0.20.
// That branch was UNPUSHED until now, and the repository's DEFAULT branch is
// `dev`. So anyone cloning the repo gets a tree that is not the one the audit
// read, and a reviewer checking our citations against it would find files
// missing -- which looks like fabrication but is a branch mismatch.
//
// An earlier attempt at this measurement was WRONG and is corrected here: the
// citation-to-path stripping regex was mangled by shell escaping, so paths still
// carried their ":line" suffix, every lookup failed, and the "78 of 193 files do
// not exist" figure it produced was an artefact. Paths are stripped in JS below,
// with the regex written once and asserted against a known sample.
//
// Usage: node scripts/audit/compare-fork-branches.mjs <fork-checkout> [branch...]

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const FORK = process.argv[2]
const BRANCHES = process.argv.slice(3)
if (!FORK || BRANCHES.length === 0) {
  console.error("usage: compare-fork-branches.mjs <fork-checkout> <branch> [branch...]")
  process.exit(1)
}

const sh = (args) => {
  try {
    return execFileSync("git", ["-C", FORK, ...args], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

// --- the regex that was wrong before; assert it ---------------------------------
const stripLine = (s) => String(s).replace(/:\d+(-\d+)?$/, "")
const SAMPLES = [
  ["packages/core/src/command.ts:18", "packages/core/src/command.ts"],
  ["packages/core/src/x.ts:100-120", "packages/core/src/x.ts"],
  ["source/file.rs:1", "source/file.rs"],
  ["no/suffix/here.ts", "no/suffix/here.ts"],
]
for (const [input, want] of SAMPLES) {
  const got = stripLine(input)
  if (got !== want) {
    console.error(`! stripLine is broken: ${input} -> ${got}, expected ${want}`)
    process.exit(1)
  }
}
console.log("stripLine self-test: 4/4 ok\n")

// --- collect the fork's cited files ---------------------------------------------
const doc = JSON.parse(readFileSync(join(ROOT, "docs/audit/data/2026-09-11-d3-opencode.json"), "utf8"))
const cites = new Set()
const add = (v) => {
  const p = stripLine(v)
  if (p && !p.includes(" ") && p.includes("/")) cites.add(p)
}
for (const list of Object.values(doc.fork.domains)) for (const m of list) for (const e of m.evidence ?? []) add(e)
for (const m of doc.fork.moduleCoverage ? [] : []) void m
for (const d of doc.forkDeltas ?? []) for (const e of d.evidence ?? []) add(e)
console.log(`fork mechanisms cite ${cites.size} distinct files\n`)

// --- compare against each branch -------------------------------------------------
console.log("branch".padEnd(34) + "missing  differ")
for (const br of BRANCHES) {
  const existsRef = sh(["rev-parse", "--verify", "--quiet", br])
  if (!existsRef) {
    console.log(`${br.padEnd(34)}  (ref not found)`)
    continue
  }
  const changed = new Set(
    (sh(["diff", "--name-only", br, "999.0.20"]) ?? "")
      .split("\n")
      .filter(Boolean),
  )
  let missing = 0
  const missingEx = []
  let differ = 0
  for (const f of cites) {
    const ok = sh(["cat-file", "-e", `${br}:${f}`])
    if (ok === null) {
      missing++
      if (missingEx.length < 6) missingEx.push(f)
      continue
    }
    if (changed.has(f)) differ++
  }
  console.log(`${br.padEnd(34)}${String(missing).padStart(6)}  ${String(differ).padStart(6)}`)
  for (const m of missingEx) console.log(`      missing: ${m}`)
}
console.log(`\n(total cited files: ${cites.size})`)
