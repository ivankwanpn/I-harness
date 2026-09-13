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
    prepend: "packages/compaction/command-compact/src/index.ts:10-11",
    reason:
      "packages/compaction/compaction-basic/src/index.ts:369 is the ENGINE's compactNow, but the claim is about the command's identity (name/inject) and its /compact registration, which live in command-compact; the cited file exports no name/inject at all",
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
  // Round 2 findings: mechanism true, carrier too weak.
  {
    file: "2026-09-11-codex-enriched.json",
    command: "copy",
    prepend: "codex-rs/tui/src/chatwidget/interaction.rs:300-327",
    reason: "the sampled cite is the doc comment at :299; the body that does last_agent_markdown -> copy_to_clipboard starts at :300",
  },
  {
    file: "2026-09-11-codex-enriched.json",
    command: "logout",
    // NOTE the `chatwidget/` segment. The verifier reported this locus as
    // `slash_dispatch.rs:401-403`, which does not resolve -- the file is at
    // tui/src/chatwidget/slash_dispatch.rs. A verifier's suggested correction is
    // ITSELF a claim, and the mechanical citation check is what caught this one.
    prepend: "codex-rs/tui/src/chatwidget/slash_dispatch.rs:401-403",
    removeCite: "codex-rs/tui/src/slash_dispatch.rs:401-403",
    reason:
      "the sampled cite slash_command.rs:225 is an available_during_task=false match arm (a gating listing), not the logout mechanism",
  },
  {
    file: "2026-09-11-grok-enriched.json",
    command: "multiline",
    prepend: "crates/codegen/xai-grok-pager/src/slash/commands/multiline.rs:27-30",
    reason: "the sampled cite slash/commands/mod.rs:128 is a registry vec entry; the behaviour lives in multiline.rs",
  },
  {
    file: "2026-09-11-grok-enriched.json",
    command: "fullscreen",
    prepend: "crates/codegen/xai-grok-pager/src/slash/commands/screen_mode_switch.rs:77-79",
    reason:
      "the sampled cite :39 is the `[\"full\"]` alias expression only; the switch itself is the RelaunchInScreenMode result, executed in app/dispatch/router.rs:182-195 -- and it is a relaunch, not an in-place flip",
  },
  {
    file: "2026-09-11-cc-custom-enriched.json",
    command: "plan",
    prepend: "src/commands/plan/plan.tsx:75-82",
    reason: "the sampled cite :70 reads the current mode; the mode is actually WRITTEN via setAppState + applyPermissionUpdate setMode:'plan' at :75-82",
  },
  {
    file: "2026-09-11-cc-custom-enriched.json",
    command: "exit",
    prepend: "src/commands/exit/exit.tsx:18-30",
    reason:
      "the sampled cite :30 is reached only after the bg-session detach (:18-24) and worktree ExitFlow (:25-28) branches are skipped; the range shows the actual decision",
  },
]

/**
 * Corrections to PACKAGE design-decision citations (the backend inventory, not
 * the command matrix). `matchCause` selects the decision by a substring of its
 * evidence, because decision text is long and would make a brittle key.
 */
const PACKAGE_CORRECTIONS = [
  {
    file: "2026-09-11-ih-backend-engine.json",
    pkg: "instructions",
    matchCause: "packages/instructions/src/files.ts:64",
    prepend: "packages/instructions/src/index.ts:24",
    alsoAdd: ["packages/instructions/src/index.ts:9", "packages/instructions/src/index.ts:47-50"],
    reason:
      "renderInstructions (files.ts:64-67) only emits `### <path>` headers joined by blank lines -- it has no maxBytes parameter and no truncation. The cap and the literal '(truncated)' suffix are in the sibling src/index.ts (:24, default 24_000 at :9, applied :47-50). Substantive correction: the cap counts UTF-16 code units (.length), NOT bytes.",
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
      // A correction can supersede an earlier one that named a path which does
      // not resolve; drop that dead reference rather than leave it behind.
      const cleaned = c.removeCite ? ev.filter((e) => e !== c.removeCite) : ev
      if (cleaned.includes(c.prepend)) {
        if (cleaned.length !== ev.length) {
          cmd.evidence = cleaned
          applied++
          report.push(`FIX   ${file} /${c.command}: removed dead citation ${c.removeCite}`)
        } else {
          report.push(`SKIP  ${file} /${c.command}: already leads with the implementing citation`)
        }
        continue
      }
      cmd.evidence = [c.prepend, ...cleaned]
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

// ---- package design-decision corrections (the backend inventory) ------------
for (const c of PACKAGE_CORRECTIONS) {
  const path = join(DATA, c.file)
  const data = JSON.parse(readFileSync(path, "utf8"))
  const pkg = (data.packages ?? []).find((p) => p.name === c.pkg)
  if (!pkg) {
    console.error(`MISS  ${c.file} has no package '${c.pkg}' -- correction not applied`)
    continue
  }
  const decision = (pkg.designDecisions ?? []).find((d) => (d.evidence ?? []).some((e) => e.includes(c.matchCause)))
  if (!decision) {
    console.error(`MISS  ${c.pkg} has no decision citing ${c.matchCause} -- correction not applied`)
    continue
  }
  const added = [c.prepend, ...(c.alsoAdd ?? [])].filter((e) => !(decision.evidence ?? []).includes(e))
  if (added.length === 0) {
    report.push(`SKIP  ${c.file} /${c.pkg}: already carries the implementing citations`)
    continue
  }
  decision.evidence = [...added, ...(decision.evidence ?? [])]
  decision.citationCorrected = { prepended: added, reason: c.reason, by: "adversarial verification sample 2 (2026-09-12)" }
  applied++
  report.push(`FIX   ${c.file} /${c.pkg} decision: prepended ${added.join(", ")}`)
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
