#!/usr/bin/env node
// scripts/audit/extract-mechanisms.mjs
//
// Phase 0 for D3 (the seven-way BACKEND MECHANISM matrix).
//
// Enumerates every module of every source and maps it to one of the 12 domains
// in docs/audit/data/2026-09-11-d3-domains.json. This is deliberately NOT an
// LLM: the purpose is that "we covered everything that exists" becomes a
// CHECKABLE claim rather than an assertion. Every module count downstream
// derives from this file, so a domain that silently lost a source's modules
// shows up as a coverage gap instead of an omission nobody notices.
//
// Module granularity differs wildly across the seven sources (IH 65 packages,
// codex 104 crates, grok ~90) and the counts are NOT comparable -- which is
// exactly why D3's rows are mechanisms and not modules. The module list exists
// to guarantee completeness of the survey, not to be the table.
//
// Usage: node scripts/audit/extract-mechanisms.mjs [--json]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs"
import { join, resolve, relative } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const DATA = join(ROOT, "docs/audit/data")

const SOURCES = {
  ih: { root: "D:/I-harness-main", layout: "flat", dirs: ["packages", "apps"] },
  dsh: { root: "D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2", layout: "dsh", dirs: ["packages"] },
  codex: { root: "D:/agent-complete/codex-rust-v0.149.1", layout: "flat", dirs: ["codex-rs"] },
  opencode: { root: "D:/agent-complete/opencode-1.18.30", layout: "flat", dirs: ["packages"] },
  "opencode-fork": { root: "D:/agent-complete/opencode-fork-private-999.0.15", layout: "flat", dirs: ["packages"] },
  grok: { root: "D:/agent-complete/grok-build-main", layout: "grok", dirs: ["crates/codegen", "crates"] },
  "cc-custom": { root: "D:/opencode-bugfix/cc-custom", layout: "cc", dirs: ["src"] },
}

const domains = JSON.parse(readFileSync(join(DATA, "2026-09-11-d3-domains.json"), "utf8"))

/**
 * Domain assignment is keyword-driven and deliberately simple. A module may
 * match several domains; the FIRST matching domain in declaration order wins,
 * because the domains are ordered from most-specific to most-cross-cutting and
 * a module like `core-agent` (which touches tools, context and session) belongs
 * with the loop. Multi-domain hits are recorded so the assignment is auditable
 * rather than assumed.
 */
const DOMAIN_KEYWORDS = {
  // NOTE: no bare "core/" keyword here. opencode nests its whole engine under
  // packages/core/src/*, so "core/" matched all 26 submodules and filed the
  // entire engine under the agent loop. Each submodule must classify on its OWN
  // name; the FIRST matching domain in this declaration order wins.
  loop: ["agent", "core-agent", "agent-loop", "grok-agent", "prompt-queue", "message-delivery", "interjection", "query", "coordinator", "executor", "session/prompt", "turn", "step", "inbox", "input"],
  session: ["session", "core-session", "session-persistence", "session-executor", "session-query", "session-title", "fs-lock", "sqlite-journal", "session-events", "rollout", "thread-store", "thread-manager", "state", "database", "storage", "journal", "migration", "history", "session-format", "session-projection", "session-checkpoint", "session-stats", "session-turn-outline", "session-log", "active-sessions", "foreign-sessions", "dashboard-store", "checkpoint", "rewind", "resume", "archive", "event", "project", "sync", "bus"],
  context: ["compaction", "token-meter", "token-estimation", "output-retention", "runtime-context", "context-fragment", "system-context", "context", "instructions", "prompt", "summar", "budget"],
  tools: ["tool", "core-tools", "tools", "fs", "filesystem", "file-system", "file-search", "file-watcher", "fsnotify", "shell", "exec", "terminal", "pty", "text-diff", "diff", "apply-patch", "guard-", "hunk-tracker", "ripgrep", "subprocess", "process-hardening", "bwrap", "spill", "workspace", "worktree", "gix", "git", "git-utils", "code-runtime", "file-utils", "native-command", "patch", "snapshot"],
  subagent: ["subagent", "agent-team", "agent-graph", "agent-identity", "agent-lifecycle", "workload-identity", "workflow", "tasks", "jobs", "schedule", "goal", "plan-mode", "plan/", "todo", "background", "delegation"],
  safety: ["sandbox", "permission", "approval", "execpolicy", "secrets", "identity", "keyring", "preset", "timeout-policy", "guard"],
  model: ["llm", "provider", "model", "credential", "sampler", "sampling", "auth", "chatgpt", "ollama", "lmstudio", "aws-auth", "responses-api", "models", "login", "oauth", "account", "copilot", "env"],
  extension: ["mcp", "lsp", "skill", "hook", "plugin", "memdir", "ext", "code-mode", "acp-lib", "connectors", "collaboration-mode", "integration", "codemode"],
  service: ["service", "web-host", "web", "sdk", "acp", "interaction", "app-server", "exec-server", "api", "host", "typert", "server", "client", "control-plane", "daemon", "uds", "websocket", "boot", "bundle", "e2b", "headless", "slack", "ssh", "console", "desktop", "enterprise", "container", "function", "share", "cli", "codex-home", "home"],
  retrieval: ["memory", "memories", "codebase-graph", "fuzzy-file", "attachment", "image", "reference", "install-context", "session-search", "embedding", "index", "question"],
  ops: ["telemetry", "feedback", "diagnostics", "crash-handler", "update", "mixpanel", "otel", "analytics", "build-info", "benchmark", "tracing", "announcements", "version", "diag", "gboom", "stats", "runtime-diagnostics", "features", "flag", "observability", "installation", "inspector", "network-proxy"],
  interface: ["tui", "tui-core", "pager", "ratatui", "render", "markdown", "mermaid", "status-line", "screens", "ink", "components", "keybindings", "vim", "outputStyles", "voice", "buddy", "proactive", "assistant", "session-ui", "ui", "tty", "settings", "config", "theme", "app"],
}

/**
 * Infrastructure, NOT capability. A module here is tooling, a shared utility, a
 * test helper or a build artifact; its presence or absence says nothing about
 * what a harness can do, and leaving it "unmapped" would drown the modules that
 * DO matter. Separating these makes "unmapped" mean "a real capability module
 * the classifier failed to place", which is a signal worth acting on.
 */
const INFRA_KEYWORDS = [
  "util", "utils", "test-support", "test-utils", "test-binary", "common", "shared", "ansi-escape",
  "async-utils", "build-info", "brand", "deque", "values", "time", "crypto", "atomic-write", "paths",
  "dirs", "home-paths", "package-manifest", "arg0", "scripts", "docs", "vendor", "v8-poc", "storybook",
  "schema", "schemas", "types", "constants", "effect", "format", "native-ts", "upstreamproxy",
  "http-recorder", "launch-environment", "chunked-list", "benchmarks",
  // NOTE: "codegen" is deliberately ABSENT -- grok's crates live under
  // crates/codegen/, so the word appears in EVERY grok module path and once
  // classified 81 of its 82 modules as infrastructure.
]

/**
 * A handful of modules are engine substance that lives NESTED one level deeper
 * than the package root, so treating the package as one module loses the whole
 * engine. opencode is the extreme case: `packages/core` is a single entry but its
 * `src/` holds ~30 capability directories. Without expansion opencode resolves to
 * 32 coarse modules and 22 of them "unmapped", which reads as an empty harness
 * when it is in fact a full one.
 */
const EXPAND_NESTED = {
  opencode: ["packages/core/src", "packages/opencode/src"],
  "opencode-fork": ["packages/core/src", "packages/opencode/src"],
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Count source files under a module, cheaply and with a cap. */
function countSourceFiles(dir, cap = 4000) {
  let n = 0
  const stack = [dir]
  while (stack.length && n < cap) {
    const d = stack.pop()
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === "target" || e.name === ".git") continue
      if (e.isDirectory()) stack.push(join(d, e.name))
      else if (/\.(ts|tsx|rs|js|mjs)$/.test(e.name)) n++
    }
  }
  return n
}

/**
 * Match on NAME SEGMENTS, not raw substrings.
 *
 * Substring matching over the whole path produced two classes of silent error
 * that both looked like "this harness has nothing here":
 *   - a compound-only keyword list: `session` was spelled only as
 *     "core-session" / "session-persistence" / ..., so the module literally
 *     named `core/session` matched NOTHING and dropped out of the matrix.
 *   - a path word that appears in every module of a source: "codegen" filed 81
 *     of grok's 82 modules as infrastructure.
 * Splitting on non-alphanumerics and matching whole words fixes both, and lets
 * a single keyword like "session" cover IH's `core-session`, dsh's
 * `session/session-format` and opencode's `core/session` alike.
 */
function classify(name, path) {
  const hay = `${name} ${path}`.toLowerCase()
  const words = new Set(hay.split(/[^a-z0-9]+/).filter(Boolean))
  // Tolerate plurals and gerunds: the sources spell one concept
  // "credential"/"credentials", "hook"/"hooks", "sandbox"/"sandboxing". Without
  // this a singular keyword missed the plural module and the harness looked like
  // it had no credential handling at all.
  const wordList = [...words]
  const has = (k) =>
    k.includes("-") ? hay.includes(k) : wordList.some((w) => w === k || w === `${k}s` || w === `${k}es` || w.startsWith(k))
  if (INFRA_KEYWORDS.some(has)) return { domain: "infra", allHits: [] }
  const hits = []
  for (const [id, keys] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keys.some(has)) hits.push(id)
  }
  return { domain: hits[0] ?? "unmapped", allHits: hits }
}

function modulesFor(key, cfg) {
  const out = []
  for (const d of cfg.dirs) {
    const base = join(cfg.root, d)
    if (!existsSync(base)) continue
    if (cfg.layout === "dsh") {
      // packages/<area>/<pkg>
      for (const area of listDirs(base)) {
        for (const pkg of listDirs(join(base, area))) {
          const p = join(base, area, pkg)
          out.push({ name: `${area}/${pkg}`, path: relative(cfg.root, p).replace(/\\/g, "/"), abs: p })
        }
      }
    } else {
      for (const name of listDirs(base)) {
        const p = join(base, name)
        out.push({ name, path: relative(cfg.root, p).replace(/\\/g, "/"), abs: p })
      }
    }
  }
  // de-duplicate (grok lists crates/codegen and crates, which nest)
  const seen = new Map()
  for (const m of out) if (!seen.has(m.name)) seen.set(m.name, m)

  // Expand packages whose real capability structure lives one level down.
  for (const nested of EXPAND_NESTED[key] ?? []) {
    const base = join(cfg.root, nested)
    if (!existsSync(base)) continue
    for (const sub of listDirs(base)) {
      const p = join(base, sub)
      const name = `${nested.replace(/^packages\//, "").replace(/\/src$/, "")}/${sub}`
      if (!seen.has(name)) seen.set(name, { name, path: relative(cfg.root, p).replace(/\\/g, "/"), abs: p })
    }
  }
  return [...seen.values()]
}

mkdirSync(DATA, { recursive: true })
const result = { extractedAt: new Date().toISOString().slice(0, 10), rowUnit: "mechanism", sources: {} }
const summary = []

for (const [key, cfg] of Object.entries(SOURCES)) {
  const mods = modulesFor(key, cfg)
  const byDomain = {}
  const unmapped = []
  const entries = []
  for (const m of mods) {
    const { domain, allHits } = classify(m.name, m.path)
    if (domain === "unmapped") unmapped.push(m.name)
    ;(byDomain[domain] ??= []).push(m.name)
    entries.push({ name: m.name, path: m.path, domain, alsoMatches: allHits.slice(1), files: countSourceFiles(m.abs) })
  }
  entries.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
  result.sources[key] = {
    root: cfg.root,
    moduleCount: entries.length,
    byDomain,
    unmapped,
    modules: entries,
  }
  summary.push({ key, modules: entries.length, unmapped: unmapped.length, infra: (byDomain.infra ?? []).length, domains: Object.keys(byDomain).filter((d) => d !== "infra").length })
}

const file = join(DATA, "2026-09-11-d3-modules.json")
writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf8")

console.log("source          modules  domains  unmapped  infra")
console.log("--------------  -------  -------  --------  -----")
for (const s of summary) console.log(`${s.key.padEnd(14)}  ${String(s.modules).padStart(7)}  ${String(s.domains).padStart(7)}  ${String(s.unmapped).padStart(8)}  ${String(s.infra).padStart(5)}`)

// Per-domain coverage across sources is the completeness measure D3 depends on:
// a domain where only some sources contribute is either a real absence (worth
// recording) or a classifier miss (worth fixing) -- it must not be silent.
console.log("\nmodules per domain per source:")
const ids = domains.domains.map((d) => d.id)
console.log("domain        " + Object.keys(SOURCES).map((k) => k.padStart(14)).join(""))
for (const id of ids) {
  const row = Object.keys(SOURCES).map((k) => String((result.sources[k].byDomain[id] ?? []).length).padStart(14))
  console.log(id.padEnd(14) + row.join(""))
}
const totalUnmapped = summary.reduce((a, s) => a + s.unmapped, 0)
if (totalUnmapped) {
  console.log(`\nUNMAPPED modules (${totalUnmapped}) -- the classifier found no domain keyword:`)
  for (const [k, v] of Object.entries(result.sources)) {
    if (v.unmapped.length) console.log(`  ${k}: ${v.unmapped.join(", ")}`)
  }
}
console.log(`\nwrote ${relative(ROOT, file).replace(/\\/g, "/")}`)
