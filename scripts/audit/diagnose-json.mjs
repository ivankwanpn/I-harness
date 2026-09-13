#!/usr/bin/env node
// scripts/audit/diagnose-json.mjs — locate the first structural break in a JSON file.
// Written because the JSON.parse error position points at where the parser NOTICED,
// not where the damage is: the grok inventory reported line 1162 while the actual
// break was earlier, so the message alone is not actionable.
//
// Usage: node scripts/audit/diagnose-json.mjs <file>

import { readFileSync } from "node:fs"

const p = process.argv[2]
const raw = readFileSync(p, "utf8")

let inStr = false
let esc = false
let depth = 0
let line = 1
let depthAtLineStart = 0
const anomalies = []

for (let i = 0; i < raw.length; i++) {
  const c = raw[i]
  if (c === "\n") {
    line++
    depthAtLineStart = depth
    continue
  }
  if (inStr) {
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') inStr = false
    continue
  }
  if (c === '"') {
    inStr = true
    continue
  }
  if (c === "{" || c === "[") depth++
  else if (c === "}" || c === "]") {
    depth--
    if (depth < 0 && anomalies.length === 0) anomalies.push({ line, why: "depth went negative" })
  }
}

console.log(`${p}`)
console.log(`  bytes ${raw.length}, lines ${line}`)
console.log(`  end state: inString=${inStr} depth=${depth}`)
if (inStr) console.log(`  => a STRING IS UNTERMINATED (an unescaped quote somewhere)`)
if (depth > 0) console.log(`  => ${depth} unclosed container(s) (truncated or a missing brace)`)
if (depth < 0) console.log(`  => too many closers`)
if (!inStr && depth === 0) console.log(`  => structurally balanced; the parse error is elsewhere (bad key, trailing comma)`)

// Trailing-comma / missing-key detector: a '}' or ']' immediately after a ','.
const trailing = []
const lines = raw.split(/\r?\n/)
lines.forEach((l, i) => {
  if (/,\s*$/.test(l)) {
    const next = (lines[i + 1] ?? "").trim()
    if (/^[}\]]/.test(next)) trailing.push(i + 1)
  }
})
if (trailing.length) {
  console.log(`  trailing commas before a closer at lines: ${trailing.slice(0, 12).join(", ")}${trailing.length > 12 ? " …" : ""}`)
}
for (const a of anomalies.slice(0, 5)) console.log(`  anomaly at line ${a.line}: ${a.why}`)

// Where does the document first return to depth 0? For a single top-level object
// that should happen only at the very end; an EARLIER return means the document
// closed prematurely and everything after it is stray -- which is what a
// concatenated merge produces, and is the actual damage when parse reports a
// position far from the break.
{
  let inS = false
  let e = false
  let d = 0
  let ln = 1
  const zeros = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === "\n") {
      ln++
      continue
    }
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
    if (c === "{" || c === "[") d++
    else if (c === "}" || c === "]") {
      d--
      if (d === 0) zeros.push(ln)
    }
  }
  console.log(`  depth returns to 0 at lines: ${zeros.slice(0, 6).join(", ")}${zeros.length > 6 ? " …" : ""}`)
  if (zeros.length > 1) {
    console.log(`  => the document CLOSES PREMATURELY at line ${zeros[0]}; content after it is stray (likely a concatenated merge)`)
    const ls = raw.split(/\r?\n/)
    for (let i = Math.max(0, zeros[0] - 3); i < Math.min(ls.length, zeros[0] + 2); i++) {
      console.log(`     ${String(i + 1).padStart(5)}: ${ls[i].slice(0, 120)}`)
    }
  }
}

// Depth at the start of each TWO-SPACE-INDENTED key line. In a well-formed
// document every top-level key sits at depth 1; an extra closing brace earlier
// shows up here as a later key appearing at depth 0 or less, which pinpoints the
// damage without reading a thousand lines.
{
  let inS = false
  let e = false
  let d = 0
  const ls = raw.split(/\r?\n/)
  const odd = []
  for (let ln = 0; ln < ls.length; ln++) {
    const text = ls[ln]
    const isTopKey = /^  "[^"]+"\s*:/.test(text)
    if (isTopKey && d !== 1) odd.push({ line: ln + 1, depth: d, text: text.trim().slice(0, 80) })
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
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
      if (c === "{" || c === "[") d++
      else if (c === "}" || c === "]") d--
    }
  }
  if (odd.length) {
    console.log(`  top-level keys NOT at depth 1 (${odd.length}) -- the first is where the structure broke:`)
    for (const o of odd.slice(0, 8)) console.log(`     line ${o.line} depth=${o.depth}  ${o.text}`)
  } else {
    console.log(`  every two-space-indented key sits at depth 1 (no premature close detected this way)`)
  }
}
