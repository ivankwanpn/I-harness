#!/usr/bin/env node
// scripts/audit/apply-citation-corrections.mjs
//
// Applies corrections found by ADVERSARIAL VERIFICATION, not by the extractors.
//
// Context: an independent verifier agent sampled 27 citations and re-read each
// one against the source. It found ZERO stale or invented lines -- every
// recorded lineText matched its file byte-for-byte -- but four claims cited a
// location that cannot carry them: a bundle manifest entry, a type doc comment, a
// path helper, and a builtin_commands() registry entry. In each case the claim
// itself is true and the verifier named the locus that actually implements it.
//
// The correction PREPENDS the implementing citation so that the matrix's
// mechanism column (which shows the leading citation) points at code rather than
// at a listing. Nothing is deleted: a peripheral citation is still evidence that
// the command is registered/bundled, which is a weaker but real fact, and
// removing it would hide that the original extraction chose it.
//
// Usage: node scripts/audit/apply-citation-corrections.mjs [--dry-run]

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")
const dry = process.argv.includes("--dry-run")

/** Corrections keyed by source + command, from the verifier's findings. */
const CORRECTIONS = [
  {
    file: "2026-09-11-dsh-enriched.json",
    command: "goal",
    prepend: "packages/goal/command-goal/src/index.ts:189-195",
    reason:
      "the sampled cite packages/bundle/web-app/cordis.patch.yml:411 is a bundle manifest entry whose next line is `disabled: true`; it cannot support a mechanism claim",
  },
  {
    file: "2026-09-11-dsh-enriched.json",
    command: "compact",
    prepend: "packages/compaction/command-compact/src/index.ts:57-105",
    reason:
      "the sampled cite packages/core/session/src/types.ts:427 is a SurfaceOp doc comment, not the command's implementation",
  },
  {
    file: "2026-09-11-grok-enriched.json",
    command: "remember",
    prepend: "crates/codegen/xai-grok-pager/src/slash/commands/remember.rs:16-23",
    reason: "the sampled cite xai-grok-memory/src/storage.rs:113 is a MEMORY.md path helper, not the command's run path",
  },
  {
    file: "2026-09-11-grok-enriched.json",
    command: "model",
    prepend: "crates/codegen/xai-grok-pager/src/slash/commands/model.rs:49-53",
    reason:
      "the sampled cite slash/commands/mod.rs:88 is a builtin_commands() registry vec entry; the exact-match-first ordering it claims lives in model.rs",
  },
  // The two PARTIAL verdicts where the claim is true in full but the sampled cite
  // was peripheral -- same treatment.
  {
    file: "2026-09-11-ih-commands-enriched.json",
    command: "quit",
    prepend: "packages/tui/src/app/slash/impl/tools.ts:77-83",
    reason:
      "the sampled cite apps/tui/src/index.ts:199 is a generic shutdown controller; the command's registration lives in tools.ts and its dispatch in loop.ts:2496",
  },
  {
    file: "2026-09-11-ih-commands-enriched.json",
    command: "fork",
    prepend: "packages/tui/src/app/slash/impl/sessions.ts:56-72",
    reason:
      "the sampled cite backend/embedded.ts:559 is the optional backend member; the registration, visible() gate and guard live in sessions.ts",
  },
]

const byFile = new Map()
for (const c of CORRECTIONS) {
  if (!byFile.has(c.file)) byFile.set(c.file, [])
  byFile.get(c.file).push(c)
}

let applied = 0
const report = []
for (const [file, corrections] of byFile) {
  const path = join(DATA, file)
  const data = JSON.parse(readFileSync(path, "utf8"))
  const lists = [data.commands ?? []]
  for (const list of lists) {
    for (const cmd of list) {
      const c = corrections.find((x) => x.command === cmd.rawName)
      if (!c) continue
      const ev = cmd.evidence ?? []
      if (ev.includes(c.prepend)) {
        report.push(`SKIP  ${file} /${c.command}: already leads with the implementing citation`)
        continue
      }
      cmd.evidence = [c.prepend, ...ev]
      cmd.citationCorrected = {
        prepended: c.prepend,
        reason: c.reason,
        by: "adversarial verification sample (2026-09-12)",
      }
      applied++
      report.push(`FIX   ${file} /${c.command}: prepended ${c.prepend}`)
    }
  }
  if (!dry) writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
}

// Confirm every correction actually landed on a command.
for (const c of CORRECTIONS) {
  const data = JSON.parse(readFileSync(join(DATA, c.file), "utf8"))
  const found = (data.commands ?? []).find((x) => x.rawName === c.command)
  if (!found) console.error(`MISS  ${c.file} has no command '${c.command}' -- correction not applied`)
}

console.log(report.join("\n"))
console.log(`\n${applied} correction(s) ${dry ? "would be " : ""}applied`)
