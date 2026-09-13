#!/usr/bin/env node
// scripts/audit/harvest-mechanisms.mjs
//
// Deterministic harvest of mechanism material that ALREADY EXISTS in the audit's
// own data files, grouped by domain and source.
//
// Two reasons this exists.
//
// 1. It is a FALLBACK. Phase 1's first run produced nothing in five rounds. If a
//    re-run also fails, D3 must still be deliverable from what is already
//    verified on disk rather than not at all. The material is real: the
//    command-level extractions carry a `mechanism` prose field per command
//    (~200 of them across the reference sources) and several carry a
//    `mechanisms` object keyed by subsystem. That is genuine, cited, previously
//    verified content.
//
// 2. It ACCELERATES the real survey. A Phase 1 agent that can see what the audit
//    already knows does not re-derive it, and the harvest also shows which
//    domains have NO existing material -- which is exactly where the agent's
//    reading effort should go.
//
// It is NOT a substitute for the survey: this material is command-shaped, so it
// covers the domains commands touch and misses most of session, subagent,
// safety and ops. The output records per-domain emptiness so that gap is visible
// rather than papered over.
//
// Usage: node scripts/audit/harvest-mechanisms.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve, relative } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")

/** Classify a mechanism description into a domain by keyword, reusing the Phase 0 vocabulary. */
const DOMAIN_HINTS = {
  loop: ["turn loop", "agent loop", "input tier", "steer", "followup", "inject", "queue", "interrupt", "abort", "prompt"],
  session: ["session", "persist", "journal", "rollout", "replay", "resume", "repair", "recover", "migrat", "checkpoint", "lock", "store", "transcript"],
  context: ["compact", "summar", "context window", "token", "prune", "budget", "shadow", "projection", "spill", "truncat"],
  tools: ["tool", "shell", "exec", "patch", "diff", "fs ", "filesystem", "terminal", "pty", "process", "registry", "schema"],
  subagent: ["subagent", "delegat", "task", "team", "roster", "job", "goal", "plan", "workflow", "background", "depth", "cancel tree"],
  safety: ["sandbox", "approval", "permission", "guard", "danger", "escalat", "policy", "confin", "isolat", "audit", "deny"],
  model: ["provider", "model", "protocol", "reasoning", "effort", "credential", "api key", "auth", "wire", "anthropic", "openai", "gemini", "bedrock"],
  extension: ["mcp", "lsp", "skill", "hook", "plugin", "marketplace", "workflow", "schedule", "todo"],
  service: ["http", "websocket", "sse", "rpc", "sdk", "acp", "server", "app-server", "daemon", "transport", "endpoint", "route"],
  retrieval: ["search", "index", "memory", "memories", "fts", "embedding", "attachment", "image", "graph"],
  ops: ["telemetry", "metric", "log", "diagnostic", "cost", "token usage", "feedback", "crash", "update", "benchmark"],
  interface: ["render", "tui", "screen", "theme", "status line", "keymap", "mouse", "scrollback", "pane", "layout"],
}

function guessDomain(text) {
  const hay = String(text ?? "").toLowerCase()
  let best = "unclassified"
  let bestScore = 0
  for (const [d, keys] of Object.entries(DOMAIN_HINTS)) {
    let score = 0
    for (const k of keys) if (hay.includes(k)) score++
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return bestScore === 0 ? "unclassified" : best
}

const SOURCE_FILES = {
  ih: ["2026-09-11-ih-commands-enriched.json"],
  dsh: ["2026-09-11-dsh-enriched.json"],
  codex: ["2026-09-11-codex-enriched.json"],
  opencode: ["2026-09-11-opencode-enriched.json"],
  "opencode-fork": ["2026-09-11-opencode-enriched.json"],
  grok: ["2026-09-11-grok-enriched.json"],
  "cc-custom": ["2026-09-11-cc-custom-enriched.json"],
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

const result = { harvestedAt: new Date().toISOString().slice(0, 10), note: "command-shaped material only; see powerNote", sources: {} }
const summary = []

for (const [key, files] of Object.entries(SOURCE_FILES)) {
  const items = []
  for (const f of files) {
    const doc = readJson(join(DATA, f))
    if (!doc) continue
    const body = key === "opencode" ? doc.upstream : key === "opencode-fork" ? doc.fork : doc
    if (!body) continue

    // Per-command mechanism prose -- the bulk of the material.
    for (const c of body.commands ?? []) {
      if (!c.mechanism || c.mechanism.length < 30) continue
      items.push({
        origin: `command:${c.rawName ?? c.canonical}`,
        domain: guessDomain(`${c.summary ?? ""} ${c.mechanism}`),
        text: c.mechanism,
        evidence: c.evidence ?? [],
        verified: c.verified === true,
      })
    }
    // The `mechanisms` object several sources carry -- subsystem-keyed prose.
    for (const [k, v] of Object.entries(body.mechanisms ?? {})) {
      if (typeof v !== "string" || v.length < 30) continue
      items.push({ origin: `mechanisms.${k}`, domain: guessDomain(`${k} ${v}`), text: v, evidence: [], verified: false })
    }
    // Notes that describe the whole command/operation model.
    for (const k of ["commandModelNote", "equivalentSurface", "pluginKernel"]) {
      if (typeof body[k] === "string" && body[k].length > 30) {
        items.push({ origin: k, domain: guessDomain(body[k]), text: body[k], evidence: [], verified: false })
      }
    }
  }
  const byDomain = {}
  for (const it of items) (byDomain[it.domain] ??= []).push(it)
  result.sources[key] = { itemCount: items.length, byDomain }
  summary.push({ key, items: items.length, domains: Object.keys(byDomain).length })
}

const out = join(DATA, "2026-09-11-d3-harvest.json")
writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8")

const DOMAINS = ["loop", "session", "context", "tools", "subagent", "safety", "model", "extension", "service", "retrieval", "ops", "interface"]
console.log("existing mechanism material, by source and domain")
console.log("-".repeat(78))
console.log("domain        " + Object.keys(SOURCE_FILES).map((k) => k.slice(0, 9).padStart(10)).join(""))
for (const d of DOMAINS) {
  const row = Object.keys(SOURCE_FILES).map((k) => String((result.sources[k]?.byDomain?.[d] ?? []).length).padStart(10))
  console.log(d.padEnd(14) + row.join(""))
}
console.log("unclassified  " + Object.keys(SOURCE_FILES).map((k) => String((result.sources[k]?.byDomain?.unclassified ?? []).length).padStart(10)).join(""))
console.log("-".repeat(78))
console.log("TOTAL         " + Object.keys(SOURCE_FILES).map((k) => String(result.sources[k]?.itemCount ?? 0).padStart(10)).join(""))
console.log(`\nwrote ${relative(ROOT, out).replace(/\\/g, "/")}`)
console.log("\nNOTE: this material is COMMAND-SHAPED. Domains that commands barely touch")
console.log("(session, subagent, safety, ops) will be thin here and need real reading;")
console.log("that gap is the point of the Phase 1 survey, not something this replaces.")
