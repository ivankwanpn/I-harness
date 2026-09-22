// scripts/audit/fix-assembly-citation-drift.mjs
//
// WHY THIS EXISTS
// ---------------
// D1/D3 cite IH's own source by file:line. Those citations were verified at the
// audit snapshot; code changes after it shift line numbers, and a citation that
// used to point at real code silently starts pointing at a BLANK LINE. The
// citation checker catches that (`blank line: 9`, was 0 at snapshot time), but
// nothing fixes it.
//
// This repairs the drift caused by the M62 sandbox work in
// `packages/session-executor/src/assembly.ts` (+130/-47 for the per-call policy,
// the prompt thunk and the denial shape).
//
//   :65  -> :66   `export type ModelPolicy`            (shifted by 1)
//   :85  -> :86   `export interface AssemblyOptions`   (shifted by 1)
//   :278 -> :297  the shellTimeoutMs default. The old target was a COMMENT 19
//                 lines above the constant -- already categorised by the checker
//                 as a weak carrier. :297 is the expression itself
//                 (`opts.shellTimeoutMs ?? 120_000`), so this STRENGTHENS the
//                 citation rather than merely re-offsetting it.
//
// Deliberately NOT touched: `packages/compaction/src/config.ts:99`, which the
// same checker reports. Verified blank at 627ca1c4 as well as at HEAD, so it is
// pre-existing debt from another change, not this one. Fixing it here would hide
// whose it is.
//
// Run: node scripts/audit/fix-assembly-citation-drift.mjs [--write]

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../..")
const WRITE = process.argv.includes("--write")

const TARGETS = [
  "docs/audit/2026-09-11-ih-backend-inventory.md",
  "docs/audit/data/2026-09-11-d3-ih.json",
  "docs/audit/data/2026-09-11-ih-backend-engine.json",
  // Added 2026-09-15: the shell/terminal citations live here too, and this file
  // was missing from the list — a repair that silently skips a target is the
  // same failure as a checker that silently skips a node.
  "docs/audit/data/2026-09-11-ih-backend-tools.json",
]

// Longest-first so `:278` cannot be partially matched by a shorter rule, and so
// a RANGE rule runs before the plain rule that is a prefix of it.
//
// The M62 sandbox work shifted lines in four cited files. Each mapping below was
// computed by reading what the line said at 627ca1c4 and finding that same
// content now — never by taking the nearest non-blank line, which would silently
// re-point a citation at whatever happens to be adjacent.
//
// TWO OF THE FIVE ARE RANGES, and both were rotated past each other:
//   terminal/src/tool.ts:5-11    -> :7-24    TerminalToolDeps (grew 2 fields)
//   terminal/src/tool.ts:164-174 -> :354-379 registerTerminal (grew the opts hop)
// The second one is a trap: a plain `:164` rule applied first would have written
// `:354-174`. Order matters, which is why the ranges are listed first.
const RULES = [
  ["packages/terminal/src/tool.ts:164-174", "packages/terminal/src/tool.ts:354-379"],
  ["packages/terminal/src/tool.ts:5-11", "packages/terminal/src/tool.ts:7-24"],
  ["packages/terminal/src/tool.ts:164", "packages/terminal/src/tool.ts:354"],
  ["packages/shell/src/index.ts:270", "packages/shell/src/index.ts:444"],
  ["packages/shell/src/index.ts:130", "packages/shell/src/index.ts:132"],
  ["packages/session-executor/src/assembly.ts:278", "packages/session-executor/src/assembly.ts:297"],
  ["packages/session-executor/src/assembly.ts:85", "packages/session-executor/src/assembly.ts:86"],
  ["packages/session-executor/src/assembly.ts:65", "packages/session-executor/src/assembly.ts:66"],
]

let totalChanges = 0
for (const rel of TARGETS) {
  const path = join(ROOT, rel)
  const before = readFileSync(path, "utf8")
  let after = before
  const counts = []
  for (const [from, to] of RULES) {
    const n = after.split(from).length - 1
    if (n > 0) {
      after = after.split(from).join(to)
      counts.push(`${from.slice(-3)}->${to.slice(-3)} x${n}`)
    }
  }
  const changed = after !== before
  if (changed && WRITE) writeFileSync(path, after, "utf8")
  totalChanges += counts.reduce((a, c) => a + Number(c.split("x")[1]), 0)
  console.log(`${changed ? (WRITE ? "WROTE " : "WOULD ") : "clean "} ${rel}${counts.length ? "  " + counts.join(", ") : ""}`)
}
console.log(`\n${totalChanges} citation(s) ${WRITE ? "rewritten" : "to rewrite"}.`)
if (!WRITE) console.log("Dry run. Re-run with --write to apply.")
