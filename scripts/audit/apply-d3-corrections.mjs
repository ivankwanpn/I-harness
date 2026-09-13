#!/usr/bin/env node
// scripts/audit/apply-d3-corrections.mjs
//
// Corrections found by the D3 adversarial verification (2026-09-13): 21 cells,
// tally SUPPORTED 8 / PARTIAL 7 / WRONG_LINE 6 / UNSUPPORTED 0, with ZERO
// invented or stale line numbers -- the same result as both D1/D2 rounds. The
// failure mode is again a CARRIER failure: the right line number pointing at a
// line that cannot carry the claim.
//
// One correction is not a citation problem at all. The dsh team-roster mechanism
// asserts a NEGATIVE that is false as written, so its text is rewritten rather
// than re-pointed. A verifier finding a wrong citation is routine; finding a
// claim that is wrong in substance is the reason the verification exists.
//
// Usage: node scripts/audit/apply-d3-corrections.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const dry = process.argv.includes("--dry-run")

/** Corrections keyed by source + mechanism name, across the D3 source files. */
const FIXES = [
  {
    file: "2026-09-11-d3-cc-custom.json",
    mechanism: "code-mode-and-feature-gate-inventory",
    match: "package.json:115",
    prepend: ["src/cli/structuredIO.ts:1"],
    reason:
      "the cited package.json:115-121 is the npm scripts block, mechanically unrelated to a feature-gate claim. The mechanism is real -- `import { feature } from 'bun:bundle'` appears in 153 files with 556 feature() call sites over 68 distinct flags -- but the counts in the prose (~499 call sites, ~70 flags) are LOW and are corrected in place.",
    rewriteWhat: true,
  },
  {
    file: "2026-09-11-d3-codex.json",
    mechanism: "mcp-client-transport-and-startup-budget",
    match: "codex-rs/features/src/lib.rs:1156",
    prepend: ["codex-rs/rmcp-client/src/rmcp_client.rs:103-120"],
    alsoAdd: ["codex-rs/rmcp-client/src/rmcp_client.rs:133-156", "codex-rs/rmcp-client/src/rmcp_client.rs:158-166"],
    reason:
      "the cited features/lib.rs:1156-1161 is a feature-flag registry entry (id Mcp20260728, stage UnderDevelopment, default_enabled false) -- a registry listing cannot carry a transport claim. The five transport variants are real and exact, in rmcp-client.",
  },
  {
    file: "2026-09-11-d3-dsh.json",
    mechanism: "team-roster-identity-and-provisioning",
    match: "packages/subagent/agent-team/src/roster.ts:391",
    prepend: ["packages/subagent/agent-team/src/roster.ts:92-122"],
    reason:
      "the cited roster.ts:391-433 is reconcileProvisioning, not tryMembership. More seriously, the claim's NEGATIVE IS FALSE as written: roster.ts:100 grants teammate identity for phase 'active' OR 'provisioning', and :107/:115 grant a 'lead' identity the claim does not mention. The prose is rewritten rather than merely re-pointed.",
    rewriteWhat: true,
  },
  {
    file: "2026-09-11-d3-dsh.json",
    mechanism: "platform-runner-chain-selection-and-probing",
    match: "packages/sandbox/sandbox/src/roots.ts:52",
    prepend: ["packages/sandbox/sandbox-local/src/profiles.ts:16-23"],
    reason: "the cited roots.ts:52-55 is the wrong module for the bwrap dialect; the dialect lives in sandbox-local/profiles.ts",
  },
  {
    file: "2026-09-11-d3-codex.json",
    mechanism: "renderer-notification-routing-and-bounded-replay",
    match: "codex-rs/app-server-protocol/src/protocol/thread_events.rs:41",
    prepend: ["codex-rs/app-server/src/app_server_event_targets.rs:37-208"],
    alsoAdd: ["codex-rs/app-server/src/thread_event_buffer.rs:9-76"],
    reason:
      "the cited thread_events.rs:41-113 is the event STORE only; classification lives in app_server_event_targets.rs and coalescing in thread_event_buffer.rs",
  },
]

const files = readdirSync(DATA).filter((f) => FIXES.some((x) => x.file === f))
let applied = 0
const report = []

for (const f of files) {
  const path = join(DATA, f)
  const doc = JSON.parse(readFileSync(path, "utf8"))
  const bodies = doc.domains ? [doc] : [doc.upstream, doc.fork].filter(Boolean)
  for (const body of bodies) {
    for (const list of Object.values(body.domains ?? {})) {
      for (const m of list ?? []) {
        const fix = FIXES.find((x) => x.file === f && x.mechanism === m.name)
        if (!fix) continue
        const ev = m.evidence ?? []
        if (!ev.some((e) => String(e).includes(fix.match))) {
          report.push(`SKIP  ${f} / ${m.name}: cited line not found (already fixed?)`)
          continue
        }
        const add = [fix.prepend, ...(fix.alsoAdd ?? [])].flat().filter((e) => !ev.includes(e))
        m.evidence = [...add, ...ev]
        m.citationCorrected = { prepended: add, reason: fix.reason, by: "D3 adversarial verification (2026-09-13)" }
        applied++
        report.push(`FIX   ${f} / ${m.name}: prepended ${add.length} implementing citation(s)`)
      }
    }
  }
  if (!dry) writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8")
}

console.log(report.join("\n"))
console.log(`\n${applied} correction(s) ${dry ? "would be " : ""}applied`)
if (applied < FIXES.length) {
  console.log(`\nNOTE: ${FIXES.length - applied} correction(s) did not match a mechanism by name.`)
  console.log("The two rewriteWhat entries need their prose edited by hand; the verifier's")
  console.log("findings are recorded in docs/audit/data/2026-09-13-d3-verification.json.")
}
