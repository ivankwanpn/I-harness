#!/usr/bin/env node
// scripts/audit/extract-commands.mjs
//
// Phase 0 of docs/superpowers/specs/2026-09-11-backend-inventory-sevenway-design.md
//
// Mechanically extracts the command surface of each of the seven sources. This
// step is deliberately NOT an LLM: the union built from these JSON files must be
// reproducible and diffable, and any structural claim in the final matrix has to
// trace back to a registration site rather than to a model's impression.
//
// The authoritative registration site differs per source, and getting it wrong
// silently corrupts the table. Two traps this script exists to avoid:
//
//   grok  -- file name != command name. `plugin.rs` declares skills/hooks/
//            marketplace/plugins, and `screen_mode_switch.rs` constructs TWO
//            commands (minimal/fullscreen). The truth is `slash_meta!{name:...}`.
//   codex -- the input token and the displayed name can differ. `Pwd` carries
//            #[strum(to_string="pwd", serialize="cwd")]: `cwd` is what the user
//            types, `pwd` is what the popup shows. EnumString parses `serialize`,
//            so the input token is `cwd`. Both are recorded.
//
// Usage: node scripts/audit/extract-commands.mjs [--out <dir>] [--json]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative, basename, resolve } from "node:path"
import { execFileSync } from "node:child_process"

const ROOT = resolve(process.argv[1], "../../..")
const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const OUT_DIR = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, "docs/audit/data")
const QUIET = args.includes("--quiet")

const SOURCES = {
  ih: "D:/I-harness-main",
  dsh: "D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2",
  codex: "D:/agent-complete/codex-rust-v0.149.1",
  opencode: "D:/agent-complete/opencode-1.18.30",
  "opencode-fork": "D:/agent-complete/opencode-fork-private-999.0.15",
  grok: "D:/agent-complete/grok-build-main",
  "cc-custom": "D:/opencode-bugfix/cc-custom",
}

// ---------------------------------------------------------------- utilities

/** Read a file, or "" when absent -- callers treat absence as "no evidence". */
function slurp(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

/** All files under dir whose name matches pred, as absolute paths. */
function walk(dir, pred, acc = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "target") continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, pred, acc)
    else if (pred(e.name)) acc.push(full)
  }
  return acc
}

/** 1-based line number of the first line containing needle. */
function lineOf(text, needle) {
  const i = text.split(/\r?\n/).findIndex((l) => l.includes(needle))
  return i < 0 ? null : i + 1
}

/** "path:line" relative to the source root, for use as evidence. */
function evidence(sourceRoot, abs, needle) {
  const rel = relative(sourceRoot, abs).replace(/\\/g, "/")
  if (needle == null) return rel
  const n = lineOf(slurp(abs), needle)
  return n == null ? rel : `${rel}:${n}`
}

function rev(sourceRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Identify a source that is not a git checkout. Extracted release trees carry no
 * .git, so the revision has to come from a manifest. Two traps this guards:
 * the DIRECTORY NAME can disagree with the real version
 * (`opencode-fork-private-999.0.15` actually contains 999.0.19), so the
 * directory name is recorded but never trusted as the version.
 */
function identify(sourceRoot) {
  const git = rev(sourceRoot)
  const dirName = basename(sourceRoot)
  let version = null
  let versionSource = null

  const revFile = join(sourceRoot, "SOURCE_REV")
  if (existsSync(revFile)) {
    const v = slurp(revFile).trim()
    if (v) {
      version = v
      versionSource = "SOURCE_REV"
    }
  }
  if (!version) {
    // probe the manifests that exist in these trees, most specific first
    const probes = [
      ["package.json", /"version"\s*:\s*"([^"]+)"/],
      ["packages/opencode/package.json", /"version"\s*:\s*"([^"]+)"/],
      ["codex-rs/Cargo.toml", /^version\s*=\s*"([^"]+)"/m],
      ["Cargo.toml", /^version\s*=\s*"([^"]+)"/m],
    ]
    for (const [rel, re] of probes) {
      const p = join(sourceRoot, rel)
      if (!existsSync(p)) continue
      const m = slurp(p).match(re)
      if (m) {
        version = m[1]
        versionSource = rel
        break
      }
    }
  }
  // A directory-name version that contradicts the manifest is worth surfacing:
  // it silently mislabels every citation if left implicit.
  const dirVersion = (dirName.match(/(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)$/i) || [])[1] || null
  return {
    sourceRev: git,
    version,
    versionSource,
    dirName,
    versionMismatch: Boolean(dirVersion && version && dirVersion !== version),
    dirVersion,
  }
}

const snakeToKebab = (s) => s.replace(/_/g, "-")
const camelToKebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()

function env(source, sourcePath, commandModel, commands) {
  return {
    source,
    sourcePath,
    ...identify(sourcePath),
    extractedAt: new Date().toISOString().slice(0, 10),
    commandModel,
    count: commands.length,
    commands,
  }
}

// ------------------------------------------------------------------ per source

/**
 * Return {canonical, note} for cross-source reconciliation. Deliberately
 * conservative: only strips a leading verb that provably means the same thing
 * across all seven sources. Ambiguity is left for the human/agent pass, per
 * design §6 rule 3 (never force a crosswalk to raise coverage).
 */
function canonicalise(raw) {
  return { canonical: raw, note: null }
}

// -- I-harness ---------------------------------------------------------------
// Registration: packages/tui/src/app/slash/impl/*.ts, each entry an object
// literal with name/aliases/description and an optional visible() capability
// gate. The registry (registry.ts) is a pure table; the loop owns the context.
function extractIH() {
  const root = SOURCES.ih
  const dir = join(root, "packages/tui/src/app/slash/impl")
  const cmds = []
  for (const f of walk(dir, (n) => n.endsWith(".ts"))) {
    const text = slurp(f)
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      const m = line.match(/^\s*name:\s*"([^"]+)"/)
      if (!m) return
      const raw = m[1]
      // aliases may be on this line or the next few
      const window = lines.slice(i, i + 6).join("\n")
      const al = window.match(/aliases:\s*\[([^\]]*)\]/)
      const aliases = al
        ? [...al[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
        : []
      const dm = window.match(/description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/)
      const vm = window.match(/visible:\s*([^,\n]+)/)
      cmds.push({
        rawName: raw,
        canonical: raw,
        aliases,
        displayName: raw,
        description: dm ? dm[1] : null,
        gate: vm ? `capability:${vm[1].trim()}` : "none",
        mechanism: null,
        evidence: [evidence(root, f, `name: "${raw}"`)],
        verified: false,
      })
    })
  }
  // CLI host surface (apps/cli) -- not slash commands, recorded separately.
  return { commands: dedupe(cmds, root), hosts: extractIHHosts(root) }
}

function extractIHHosts(root) {
  const f = join(root, "apps/cli/src/index.ts")
  const text = slurp(f)
  const usage = text.match(/"usage: i-harness([^;]*?)"/s)
  const hosts = ["run", "web", "sdk", "acp", "tui", "sessions"].map((h) => ({
    host: h,
    evidence: evidence(root, f, h),
  }))
  return { usageLine: usage ? usage[1].slice(0, 400) : null, hosts }
}

// -- dsh ---------------------------------------------------------------------
// Registration: a slash command exists ONLY if some package calls
//   ctx.commands.register({ name: '...', description: '...', handler })
// on the Cordis `commands` service. There is no central table, so the sweep has
// to be repository-wide: the three `command-*` packages are merely the ones
// shipped as standalone packages, and three MORE commands are registered inline
// from their domain packages (/permission, /plan, /export).
//
// An earlier version of this extractor guessed at a `session-send` /
// `session-followup` / `session-steer` / `session-inject` "interaction command"
// family carried over from the audited harness's own docs. Those literal names
// do NOT occur anywhere in dsh 0.1.5-rc.2 (whole-tree grep: zero hits). The real
// delivery model is four in-process Agent tiers -- send / followup / steer /
// inject -- which are API calls, not commands, and are therefore documented by
// the extraction agent rather than fabricated here as command rows.
function extractDsh() {
  const root = SOURCES.dsh
  const cmds = []
  const sites = []
  for (const f of walk(join(root, "packages"), (n) => n.endsWith(".ts"))) {
    if (/[\\/](tests?|__tests__)[\\/]/.test(f) || /\.(spec|test)\.ts$/.test(f)) continue
    const text = slurp(f)
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/commands\.register\(/.test(line)) return
      // the registered object's fields are on the following lines
      const win = lines.slice(i, i + 10).join("\n")
      const nm = win.match(/name:\s*'([^']+)'/)
      if (!nm) return
      const desc = win.match(/description:\s*'([^']*)'/)
      const hint = win.match(/hint:\s*'([^']*)'/)
      const rel = relative(root, f).replace(/\\/g, "/")
      sites.push({ file: rel, line: i + 1, name: nm[1] })
      // the package's own USAGE string, when present, independently names the
      // human-facing slash form -- recorded so the two can be cross-checked
      const usage = text.match(/USAGE\s*=\s*'Usage:\s*(\/[a-z0-9-]+)/)
      cmds.push({
        rawName: nm[1],
        canonical: nm[1],
        aliases: [],
        displayName: nm[1],
        description: desc ? desc[1] : null,
        inputHint: hint ? hint[1] : null,
        usageCrossCheck: usage ? usage[1].slice(1) : null,
        gate: "dsh:commands-service",
        mechanism: null,
        evidence: [`${rel}:${i + 1}`],
        verified: false,
      })
    })
  }
  return { commands: dedupe(cmds, root), registerSites: sites }
}

// -- codex -------------------------------------------------------------------
// Registration: codex-rs/tui/src/slash_command.rs, one enum variant per command,
// #[strum(serialize_all="kebab-case")] with per-variant overrides. EnumString
// parses `serialize`; `to_string` is the DISPLAY name. They can differ.
function extractCodex() {
  const root = SOURCES.codex
  const f = join(root, "codex-rs/tui/src/slash_command.rs")
  const text = slurp(f)
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes("pub enum SlashCommand"))
  const cmds = []
  if (start >= 0) {
    let pending = []
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^\}/.test(line)) break
      const t = line.trim()
      if (t.startsWith("#[strum")) {
        pending.push(t)
        continue
      }
      if (t.startsWith("//") || t === "") continue
      const vm = t.match(/^([A-Z][A-Za-z0-9]*),?$/)
      if (!vm) continue
      const variant = vm[1]
      const attrs = pending.join(" ")
      pending = []
      const ser = attrs.match(/serialize\s*=\s*"([^"]+)"/)
      const toStr = attrs.match(/to_string\s*=\s*"([^"]+)"/)
      // EnumString matches `serialize` when given, else kebab-case(variant).
      const input = ser ? ser[1] : camelToKebab(variant)
      const display = toStr ? toStr[1] : input
      const aliases = []
      if (toStr && ser && ser[1] !== toStr[1]) aliases.push(ser[1])
      cmds.push({
        rawName: input,
        canonical: canonicalise(input).canonical,
        aliases: aliases.filter((a) => a !== input),
        displayName: display,
        variant,
        description: null,
        gate: "none",
        mechanism: null,
        evidence: [evidence(root, f, `${variant},`)],
        verified: false,
      })
    }
  }
  return { commands: dedupe(cmds, root), enumFile: `${relative(root, f).replace(/\\/g, "/")}:${start + 1}` }
}

// -- opencode / opencode-fork ------------------------------------------------
// Only two BUILT-IN commands exist (init/review); everything else is user/config
// markdown resolved at runtime, so this source has no static command list to
// enumerate. That is a design difference, not an absence -- recorded explicitly.
//
// The registry moved between the two trees, and the fork's copy is NOT at the
// upstream path (its packages/opencode/src/command/ holds only template/):
//   upstream 1.18.30     packages/opencode/src/command/index.ts  -> `Default = { INIT: "init", ... }`
//   fork 999.0.19        packages/core/src/command.ts            -> `export const INIT = "init"`
// Both are probed so a future re-run cannot silently report zero.
const OPENCODE_REGISTRIES = {
  opencode: ["packages/opencode/src/command/index.ts", "packages/core/src/command.ts"],
  "opencode-fork": ["packages/core/src/command.ts", "packages/opencode/src/command/index.ts"],
}

function extractOpencode(key) {
  const root = SOURCES[key]
  const cmds = []
  const used = []
  for (const rel of OPENCODE_REGISTRIES[key]) {
    const f = join(root, rel)
    if (!existsSync(f)) continue
    const text = slurp(f)
    // style A: a `Default = { KEY: "value" }` object literal
    const defBlock = text.match(/export const Default = \{([^}]*)\}/)
    if (defBlock) {
      for (const m of defBlock[1].matchAll(/([A-Z_]+):\s*"([^"]+)"/g)) {
        cmds.push({
          rawName: m[2],
          canonical: m[2],
          aliases: [],
          displayName: m[2],
          constName: m[1],
          description: null,
          gate: "none",
          mechanism: null,
          evidence: [evidence(root, f, `${m[1]}: "${m[2]}"`)],
          verified: false,
        })
      }
    }
    // style B: standalone `export const KEY = "value"` declarations
    for (const m of text.matchAll(/export const ([A-Z][A-Z0-9_]*) = "([^"]+)"/g)) {
      if (cmds.some((c) => c.rawName === m[2])) continue
      cmds.push({
        rawName: m[2],
        canonical: m[2],
        aliases: [],
        displayName: m[2],
        constName: m[1],
        description: null,
        gate: "none",
        mechanism: null,
        evidence: [evidence(root, f, `export const ${m[1]} = "${m[2]}"`)],
        verified: false,
      })
    }
    if (cmds.length) used.push(rel)
  }
  return {
    commands: dedupe(cmds, root),
    registryFiles: used,
    dynamic: true,
    dynamicNote:
      "Only the built-in commands are static. All others are user/config markdown templates discovered at runtime; there is no static registry to enumerate.",
  }
}

// -- grok-build --------------------------------------------------------------
// Registration: slash_meta!{name:...} in every module under slash/commands/.
// NOT the file name: plugin.rs declares four commands and screen_mode_switch.rs
// constructs two. builtin_commands() is the authoritative constructor list.
//
// Three declaration forms exist, and handling only the first silently drops
// commands (measured: 67 of 71 before this was fixed):
//   a) name: "compact"             -- a literal
//   b) name: IMAGINE_COMMAND_NAME  -- a Rust CONSTANT; the human name is then
//                                     recovered from the `usage:` literal
//   c) no slash_meta! at all       -- a hand-written impl SlashCommand whose
//                                     name() is COMPUTED (screen_mode_switch
//                                     returns "minimal"/"fullscreen" through a
//                                     helper), recovered from the module doc
function extractGrok() {
  const root = SOURCES.grok
  const dir = join(root, "crates/codegen/xai-grok-pager/src/slash/commands")
  const cmds = []
  const modulesWithCommands = new Set()

  // Parse the authoritative constructor list FIRST: the form-(c) fallback below
  // must only be applied to modules that are genuinely constructed as commands.
  // Without this restriction a helper module whose doc comment merely NAMES
  // other commands (effort_levels.rs mentions `/model` and `/effort`) fabricates
  // two phantom commands and attaches bogus evidence to real ones.
  const modText = slurp(join(dir, "mod.rs"))
  const builtins = [...modText.matchAll(/Arc::new\(([a-z_]+)::([A-Za-z]+)(?:::([a-z_]+)\(\))?\)/g)].map((m) => ({
    module: m[1],
    type: m[2],
    variant: m[3] ?? null,
  }))
  const builtinModules = new Set(builtins.map((b) => b.module))

  for (const f of walk(dir, (n) => n.endsWith(".rs"))) {
    const rel = relative(root, f).replace(/\\/g, "/")
    const moduleName = basename(rel, ".rs")
    const text = slurp(f)
    let found = 0

    for (const m of text.matchAll(/slash_meta!\s*\{([\s\S]*?)\n\s*\}/g)) {
      const block = m[1]
      const desc = block.match(/description:\s*"([^"]*)"/)
      const usage = block.match(/usage:\s*"([^"]*)"/)
      const takesArgs = /takes_args:\s*true/.test(block)
      let name = null
      let nameSource = "literal"
      const lit = block.match(/name:\s*"([^"]+)"/)
      if (lit) {
        name = lit[1]
      } else {
        const ident = block.match(/name:\s*([A-Z][A-Z0-9_]*)/)
        const usageName = usage ? usage[1].match(/^\/([a-z0-9-]+)/) : null
        if (usageName) {
          name = usageName[1]
          nameSource = `usage-literal (name constant${ident ? ` ${ident[1]}` : ""})`
        }
      }
      if (!name) continue
      found++
      cmds.push({
        rawName: name,
        canonical: name,
        aliases: [],
        displayName: name,
        description: desc ? desc[1] : null,
        usage: usage ? usage[1] : null,
        takesArgs,
        module: rel,
        nameSource,
        gate: "none",
        mechanism: null,
        evidence: [evidence(root, f, usage ? `usage: "${usage[1]}"` : `name: "${name}"`)],
        verified: false,
      })
    }

    // form (c): no slash_meta! anywhere AND the module really is a constructed
    // command. The module doc comment then documents the names in backticks,
    // e.g. "`/minimal` and `/fullscreen`: ...".
    if (found === 0 && !/slash_meta!/.test(text) && builtinModules.has(moduleName)) {
      const cut = text.indexOf("\n\nuse ")
      const doc = text.slice(0, cut >= 0 ? cut : 2000)
      for (const m of doc.matchAll(/`\/([a-z][a-z0-9-]*)`/g)) {
        const name = m[1]
        found++
        cmds.push({
          rawName: name,
          canonical: name,
          aliases: [],
          displayName: name,
          description: (doc.match(/^\/\/!?\s*(.+)$/m) || [])[1] || null,
          module: rel,
          nameSource: "module-doc-comment (hand-written impl, computed name)",
          gate: "none",
          mechanism: null,
          evidence: [evidence(root, f, `\`/${name}\``)],
          verified: false,
        })
      }
    }
    if (found > 0) modulesWithCommands.add(moduleName)
  }

  // A module that is constructed in builtin_commands() but yielded no command
  // means a missed declaration form -- loud, because it shrinks the union.
  const missed = [...builtinModules].filter((m) => !modulesWithCommands.has(m))
  return {
    commands: dedupe(cmds, root),
    builtinConstructors: builtins.length,
    builtinList: builtins.map((b) => `${b.module}::${b.type}${b.variant ? `::${b.variant}` : ""}`),
    missedModules: missed,
  }
}

// -- cc-custom ---------------------------------------------------------------
// Registration: src/commands/<name>/index.ts (and some flat src/commands/*.ts),
// each exporting a COMMAND OBJECT. The name must come from that object, not from
// the first `name:` in the file: taking the first match produced a phantom
// command and dropped two real ones (measured):
//   insights.ts       `const INSIGHT_SECTIONS: InsightSection[] = [...]` is a
//                     report-section TABLE whose entries have `name:`; the real
//                     command declares `name: 'insights'` far below it. The first
//                     match recorded `project_areas`, a command that does not
//                     exist, and lost `insights`.
//   limit-controls.ts drives THREE commands from a descriptor table; taking the
//                     first lost `max-output` and `auto-compact-window`.
// The discriminator used here is shape: a command is an OBJECT literal (`= {`),
// while the tables that caused the false positives are ARRAYS (`= [`).
//
// 21 further directories are DISABLED STUBS -- one-line .js files of the form
//   export default { isEnabled: () => false, isHidden: true, name: 'stub' }
// They are not commands and must not inflate the count, but they are real tree
// content, so they are recorded separately rather than dropped silently.

/**
 * Object-literal regions of a module: `const X = {` … matching close,
 * `export default {`, and CALL SITES that take an object argument such as
 * `createMovedToPluginCommand({ ... })`. Brace counting is required because
 * these literals nest. The call-site form matters: cc-custom declares two
 * commands (/pr-comments, /security-review) exclusively through
 * `createMovedToPluginCommand({...})`, so matching only `= {` loses them.
 * Returns [{startLine, text}].
 */
function objectLiteralRegions(text) {
  const lines = text.split(/\r?\n/)
  const regions = []
  const starter =
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{|^\s*export\s+default\s*\{|^\s*(?:export\s+default\s+)?[A-Za-z_$][\w$]*\(\s*\{/
  for (let i = 0; i < lines.length; i++) {
    if (!starter.test(lines[i])) continue
    let depth = 0
    let started = false
    const buf = []
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]
      for (const ch of l) {
        if (ch === "{") {
          depth++
          started = true
        } else if (ch === "}") depth--
      }
      buf.push(l)
      if (started && depth <= 0) break
    }
    regions.push({ startLine: i + 1, text: buf.join("\n") })
    i += buf.length - 1
  }
  return regions
}

/** Heuristic: does this object literal look like a Command definition? */
function looksLikeCommand(regionText) {
  return /\b(type|description|isEnabled|load|userFacingName|supportsNonInteractive)\s*:/.test(regionText)
}

function extractCcCustom() {
  const root = SOURCES["cc-custom"]
  const dir = join(root, "src/commands")
  const cmds = []
  const stubs = []
  for (const f of walk(dir, (n) => /\.(ts|tsx|js|jsx)$/.test(n))) {
    const text = slurp(f)
    const rel = relative(root, f).replace(/\\/g, "/")
    if (/name:\s*'stub'/.test(text) && /isEnabled:\s*\(\)\s*=>\s*false/.test(text)) {
      stubs.push({ file: rel, note: "disabled stub (isEnabled:false, isHidden:true)" })
      continue
    }
    for (const region of objectLiteralRegions(text)) {
      if (!looksLikeCommand(region.text)) continue
      const m = region.text.match(/\bname:\s*'([^']+)'/)
      if (!m) continue
      const raw = m[1]
      const lineNo = region.startLine + (region.text.slice(0, region.text.indexOf(m[0])).split("\n").length - 1)
      const desc = region.text.match(/description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/)
      const enabled = region.text.match(/isEnabled:\s*([^,\n]+)/)
      const type = region.text.match(/\btype:\s*'([^']+)'/)
      cmds.push({
        rawName: raw,
        canonical: raw,
        aliases: [],
        displayName: raw,
        description: desc ? desc[1].slice(0, 200) : null,
        kind: type ? type[1] : null,
        gate: enabled ? `isEnabled:${enabled[1].trim().slice(0, 60)}` : "none",
        mechanism: null,
        evidence: [`${rel}:${lineNo}`],
        verified: false,
      })
    }
  }
  return { commands: dedupe(cmds, root), disabledStubs: stubs }
}

// ------------------------------------------------------------------- assemble

function dedupe(cmds, root) {
  const seen = new Map()
  for (const c of cmds) {
    const prev = seen.get(c.rawName)
    if (!prev) {
      seen.set(c.rawName, c)
      continue
    }
    // keep the first, but merge evidence so duplicates stay traceable
    for (const e of c.evidence) if (!prev.evidence.includes(e)) prev.evidence.push(e)
    if (prev.aliases && c.aliases) {
      for (const a of c.aliases) if (!prev.aliases.includes(a)) prev.aliases.push(a)
    }
  }
  return [...seen.values()].sort((a, b) => a.rawName.localeCompare(b.rawName))
}

const EXTRACTORS = {
  ih: () => {
    const r = extractIH()
    return { ...env("ih", SOURCES.ih, "registry+capability-gate", r.commands), hosts: r.hosts }
  },
  dsh: () => {
    const r = extractDsh()
    if (r.commands.length === 0) {
      throw new Error("dsh: no commands.register() sites found -- the sweep is wrong, not the source")
    }
    return {
      ...env("dsh", SOURCES.dsh, "per-package + inline commands.register", r.commands),
      registerSites: r.registerSites,
    }
  },
  codex: () => {
    const r = extractCodex()
    return { ...env("codex", SOURCES.codex, "rust-enum", r.commands), enumFile: r.enumFile }
  },
  opencode: () => {
    const r = extractOpencode("opencode")
    return { ...env("opencode", SOURCES.opencode, "builtin+markdown", r.commands), dynamic: true, registryFiles: r.registryFiles, dynamicNote: r.dynamicNote }
  },
  "opencode-fork": () => {
    const r = extractOpencode("opencode-fork")
    return {
      ...env("opencode-fork", SOURCES["opencode-fork"], "builtin+markdown", r.commands),
      dynamic: true,
      registryFiles: r.registryFiles,
      dynamicNote: r.dynamicNote,
    }
  },
  grok: () => {
    const r = extractGrok()
    if (r.missedModules.length) {
      throw new Error(
        `grok: ${r.missedModules.length} module(s) are constructed in builtin_commands() but yielded no command: ` +
          `${r.missedModules.join(", ")} -- a declaration form is unhandled; the union would silently shrink`,
      )
    }
    if (r.commands.length !== r.builtinConstructors) {
      throw new Error(
        `grok: extracted ${r.commands.length} commands but builtin_commands() constructs ${r.builtinConstructors} -- counts must match`,
      )
    }
    return {
      ...env("grok", SOURCES.grok, "per-module slash_meta", r.commands),
      builtinConstructors: r.builtinConstructors,
      builtinList: r.builtinList,
    }
  },
  "cc-custom": () => {
    const r = extractCcCustom()
    return {
      ...env("cc-custom", SOURCES["cc-custom"], "directory+isEnabled", r.commands),
      disabledStubs: r.disabledStubs,
    }
  },
}

mkdirSync(OUT_DIR, { recursive: true })
const summary = []
for (const [key, fn] of Object.entries(EXTRACTORS)) {
  let data
  try {
    data = fn()
  } catch (err) {
    console.error(`FAILED ${key}: ${err.message}`)
    process.exitCode = 1
    continue
  }
  const file = join(OUT_DIR, `2026-09-11-${key}-commands.json`)
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8")
  summary.push({
    source: key,
    count: data.count,
    model: data.commandModel,
    version: data.version,
    versionSource: data.versionSource,
    dirVersion: data.dirVersion,
    versionMismatch: data.versionMismatch,
    file: relative(ROOT, file).replace(/\\/g, "/"),
  })
}

if (!QUIET) {
  console.log("source          count  version     model")
  console.log("--------------  -----  ----------  ----------------------------")
  for (const s of summary) {
    console.log(`${s.source.padEnd(14)}  ${String(s.count).padStart(5)}  ${(s.version || "-").padEnd(10)}  ${s.model}`)
  }
  const total = summary.reduce((a, s) => a + s.count, 0)
  console.log(`${"(raw total)".padEnd(14)}  ${String(total).padStart(5)}  (pre-dedupe across sources)`)
  for (const s of summary) {
    if (s.versionMismatch) {
      console.log(`\nWARNING ${s.source}: directory says ${s.dirVersion} but ${s.versionSource} says ${s.version}`)
    }
  }
}
