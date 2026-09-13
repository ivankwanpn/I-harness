#!/usr/bin/env node
// scripts/audit/repair-json-braces.mjs
//
// Brute-force repair for a JSON file whose structure is off by a small number of
// closing braces. Written for the grok D3 inventory, which was assembled from
// concatenated sections and ended at depth -2: the parser's reported position
// (line 1162) was nowhere near the damage, and reasoning about brace depth by
// hand across 1800 lines is slower and less reliable than trying every candidate.
//
// It removes ONE closing brace at a time, from the END backwards, and reports the
// first removal that makes the document parse. Working backwards matters: an
// extra closer is usually the last one of a concatenated tail, and removing an
// early brace would silently restructure the document rather than repair it.
//
// Usage: node scripts/audit/repair-json-braces.mjs <file> [--write]

import { readFileSync, writeFileSync, copyFileSync } from "node:fs"

const file = process.argv[2]
const write = process.argv.includes("--write")
const raw = readFileSync(file, "utf8")

try {
  JSON.parse(raw)
  console.log("already parses; nothing to do")
  process.exit(0)
} catch {
  /* needs repair */
}

// Candidate positions: every `}` or `]` that is not inside a string.
const candidates = []
{
  let inS = false
  let e = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
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
    if (c === "}" || c === "]") candidates.push(i)
  }
}

const lineOf = (pos) => raw.slice(0, pos).split("\n").length

// Try removing k closers at a time, k = 1..4, drawn from the LAST `WINDOW`
// candidates. Working from the tail keeps it tractable and keeps the repair
// minimal in effect: the tail is where a concatenated merge leaves its strays.
const WINDOW = 60
const tail = candidates.slice(-WINDOW)
const combos = []
const build = (start, k, acc) => {
  if (k === 0) {
    combos.push([...acc])
    return
  }
  for (let i = start; i < tail.length; i++) {
    acc.push(tail[i])
    build(i + 1, k - 1, acc)
    acc.pop()
  }
}
for (let k = 1; k <= 4; k++) build(0, k, [])

let fixed = null
let tried = 0
for (const rm of combos) {
  tried++
  const set = new Set(rm)
  const candidate = [...raw].filter((_, i) => !set.has(i)).join("")
  try {
    const parsed = JSON.parse(candidate)
    fixed = { text: candidate, removed: rm, parsed }
    break
  } catch {
    /* keep trying */
  }
}
console.log(`  candidates tried: ${tried} (combinations of 1..4 closers from the last ${WINDOW})`)

if (!fixed) {
  console.log(`no single-brace removal repairs ${file}`)
  console.log(`  candidates tried: ${removals.length}`)
  process.exit(1)
}

const keys = Object.keys(fixed.parsed)
console.log(`REPAIRED by removing ${fixed.removed.length} closing brace(s)`)
for (const pos of fixed.removed) console.log(`  removed the closer at line ${lineOf(pos)}`)
console.log(`  resulting top-level keys: ${keys.join(", ")}`)

if (write) {
  copyFileSync(file, `${file}.bak`)
  writeFileSync(file, fixed.text, "utf8")
  console.log(`  wrote ${file} (backup at ${file}.bak)`)
} else {
  console.log(`  dry run -- pass --write to apply`)
}
