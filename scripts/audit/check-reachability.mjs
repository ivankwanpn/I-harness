#!/usr/bin/env node
// scripts/audit/check-reachability.mjs
//
// Finds what this repo DECLARES but never uses on a production path.
//
// Why it exists: three shipped features were once declared, tested and never
// wired -- the fs guard never consulted the sandbox mode, the shipped hosts never
// passed `compact`, and the TUI composes no sandbox at all. Each was found by a
// human reading code, months apart. This makes that search repeatable.
//
// What it CAN prove: nothing in the non-test tree mentions this name / constructs
// this event / reads this flag.
// What it CANNOT prove: that a declaration which IS mentioned is wired correctly,
// or that a declaration is dead rather than public API. Both are judgements, and
// they belong in the allowlist, not in a cleverer regex.
//
// Usage:
//   node scripts/audit/check-reachability.mjs                 # human table
//   node scripts/audit/check-reachability.mjs --json          # machine readable
//   node scripts/audit/check-reachability.mjs --self-test     # prove the scanners

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(process.argv[1], "../../..")
const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const AS_JSON = args.includes("--json")

/** A synthetic tree the scanners can be pointed at. Kept in TEMP, not in the repo:
 *  the repo has no script fixtures, and one inline self-test is the established
 *  shape here (compare-fork-branches.mjs:57). */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-"))
  const put = (rel, text) => {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, text, "utf8")
  }

  // class 1: `Wired` is imported by non-test code, `Orphan` is not.
  put("packages/alpha/src/index.ts", [
    "export function Wired() { return 1 }",
    "export function Orphan() { return 2 }",
    "export type OnlyAType = string",
    "export function RelativelyUsed() { return 3 }",
  ].join("\n"))
  put("packages/alpha/src/use.ts", 'import { Wired } from "@i-harness/alpha"\nWired()\n')
  put("packages/alpha/test/orphan.test.ts", 'import { Orphan } from "@i-harness/alpha"\nOrphan()\n')

  // class 2: `beta/change` is appended; `beta/ghost` is only declared and read.
  put("packages/beta/src/events.ts", 'export type E = "beta/change" | "beta/ghost"\n')
  put("packages/beta/src/write.ts", 'const e: E = "beta/change"\n')
  put("packages/beta/test/ghost.test.ts", 'const e: E = "beta/ghost"\n')

  // class 2 regression: the SAME name as a union member on its own continuation
  // line of ANOTHER file is a declaration, not a producer. Without this file the
  // fixture's only union sits in events.ts, which the scanner excludes as the
  // declaring file, so nothing would pin the `| "name"` clause -- and dropping
  // it flips the real tree's class-2 result from 1 finding to 0.
  put("packages/beta/src/types.ts", [
    "export type EventKind =",
    '  | "beta/ghost"',
    "",
  ].join("\n"))

  // class 3: `--yes` is parsed into flags and never read; `--model` is read.
  put("apps/tool/src/index.ts", [
    "type Flags = { yes: boolean; model?: string }",
    "const flags: Flags = { yes: false }",
    'case "--yes": flags.yes = true; break',
    'case "--model": flags.model = next(); break',
    "run(flags.model)",
  ].join("\n"))

  // class 3 regression: `verbose?:` is declared OPTIONAL and never read, so it IS
  // a finding -- a line-level `field:` exclusion cannot match the `?` and lets
  // the declaration read as a use. `strict?` is read, and only through `===`,
  // which is compared rather than assigned: the negative control.
  put("apps/tool-b/src/index.ts", [
    "type Flags = { verbose?: boolean; strict?: boolean }",
    "const flags: Flags = { verbose: false }",
    'case "--verbose": flags.verbose = true; break',
    'case "--strict": flags.strict = true; break',
    "if (flags.strict === true) run()",
  ].join("\n"))

  // class 1 regression: a same-package RELATIVE consumer counts as usage, and
  // `export *` is followed without marking everything it re-exports used.
  put("packages/alpha/src/local.ts", 'import { RelativelyUsed } from "./index"\nRelativelyUsed()\n')
  put("packages/epsilon/src/impl.ts", [
    "export function ReExported() { return 1 }",
    "export function UnusedReExport() { return 2 }",
  ].join("\n"))
  // `interface`, not `type`, and its OWN module: with `type`, the phantom
  // subject `type TypeOnlyExport` matched this declaration's own text, and the
  // clean name reached the entry through `export *` as well, so the case passed
  // with the modifier strip removed -- a test that certified its own defect.
  put("packages/epsilon/src/type-only.ts", "export interface TypeOnlyExport { value: string }\n")
  // The entry is a production file too: it imports this name, re-exports it and
  // calls it -- the shape the whole-entry exclusion got wrong.
  put("packages/epsilon/src/range.ts", "export function EntryCallSite() { return 4 }\n")
  put("packages/epsilon/src/index.ts", [
    'export * from "./impl"',
    'export { type TypeOnlyExport } from "./type-only.ts"',
    'import { EntryCallSite } from "./range.ts"',
    'export { EntryCallSite } from "./range.ts"',
    "const entryValue = EntryCallSite()",
    "",
  ].join("\n"))
  put("packages/epsilon/src/use.ts", 'import { ReExported } from "./impl"\nReExported()\n')

  // index regression: a dot-directory is gitignored scratch, never repo source.
  put("packages/alpha/.hidden/sneaky.ts", "export function HiddenOrphan() { return 1 }\n")

  // class 1 regression: a named re-export belongs to its DECLARER, not to the
  // file that re-exports it -- and a barrel that merely MENTIONS the name is
  // not an origin for it, or the mention that makes it used would be silenced.
  put("packages/eta/src/models.ts", [
    "export type CatalogDefault = { a: number }",
    "export type CatalogShadowed = { b: number }",
  ].join("\n"))
  put("packages/eta/src/types.ts", 'export type { CatalogDefault } from "./models.ts"\n')
  put("packages/eta/src/notes.ts", 'import type { CatalogShadowed } from "./models.ts"\ntype Notes = CatalogShadowed\n')
  put("packages/eta/src/index.ts", [
    'export * from "./types.ts"',
    'export * from "./models.ts"',
    'export * from "./notes.ts"',
    'export { type CatalogShadowed } from "./models.ts"',
    "",
  ].join("\n"))

  // class 4: `plan-mode` appears in the capability union but is never pushed.
  put("packages/gamma/src/caps.ts", 'export type Cap = "plan-mode" | "vim-mode"\n')
  put("packages/gamma/src/push.ts", 'caps.push("vim-mode")\n')

  // class 5: `compaction.auto` is in the schema, nothing reads it; `notify.on` is read.
  put("packages/delta/src/schema.ts", 'export const S = { "compaction.auto": b, "notify.on": b }\n')
  put("packages/delta/src/read.ts", 'const x = s["notify.on"]\n')

  // class 4 regression: the inventory lives in a file that is NOT named caps.ts /
  // capabilities.ts, which is this repo's shape (packages/tui/src/app/slash/
  // types.ts). Without this file the fixture's only inventory is caps.ts, so a
  // file-name anchor passes while the real tree's union stays invisible -- and it
  // did: the drafted CAP_UNION_FILE matches no file here, and the drafted scanner
  // therefore reported 0 findings over a tree with three unpushed capabilities.
  put("packages/theta/src/types.ts", 'export type PluginCapability = "alpha-cap" | "beta-cap"\n')
  put("packages/theta/src/loop.ts", 'caps.push("alpha-cap")\n')

  // class 4 regression: a union whose members are supplied some OTHER way (the
  // packages/plugin-registry/src/capability.ts shape: disk sniffing, no `push`
  // anywhere) is not a push inventory. With no member pushed, every member would
  // be invented, so this file pins the guard that skips such a union.
  put("packages/iota/src/capability.ts", 'export type Capability = "skills" | "commands"\n')

  // class 5 regression: the schema is a `*_DEFAULTS` document in a file that is
  // NOT named schema.ts, its keys are NESTED (packages/settings/src/index.ts is
  // the real one), and a read goes through a property path rather than a bracket
  // string. Without this file the fixture's only schema is already dotted-and-
  // quoted, and a property read is never exercised.
  put("packages/kappa/src/defaults.ts", 'export const APP_DEFAULTS = { ui: { themeName: "dark", fontSizePx: 14 } }\n')
  put("packages/kappa/src/read.ts", "const t = s.ui.themeName\n")

  return dir
}

const SCANNERS = []          // filled in by Tasks 2-4
const SELF_TEST_CASES = []   // { name, run(fixtureRoot) -> string[] } expected subjects

// ------------------------------------------------- class 1: unused export
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^export\s*(?:type\s*)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/gm
const EXPORT_STAR = /^export\s*\*\s*from\s*["']([^"']+)["']/gm

function exportDeclNames(text) {
  const names = new Set()
  for (const m of text.matchAll(EXPORT_DECL)) names.add(m[1])
  return [...names]
}

/** Export-list entries, each paired with the module it is re-exported FROM
 *  (null when the name is local to the file). A leading `type` / `typeof` is a
 *  keyword, not part of the name: keeping it produced subjects like
 *  `#type ServerInfo`, which no word-boundary match can ever find. */
function exportListEntries(text) {
  const out = []
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^(?:type|typeof)\s+/, "")
      if (!t) continue
      const alias = t.split(/\s+as\s+/)
      out.push({ name: (alias[1] ?? alias[0]).trim(), from: m[2] ?? null })
    }
  }
  return out
}

function exportedNames(text) {
  const names = new Set(exportDeclNames(text))
  for (const e of exportListEntries(text)) names.add(e.name)
  return [...names]
}

/** `./x` resolves to `./x.ts`, `./x.tsx`, `./x.js` (the ESM spelling of a TS
 *  file) or `./x/index.ts`. Package specifiers are out of scope: only sibling
 *  modules are followed, which is all `export *` needs. */
function resolveModule(spec, fromRel, byRel) {
  if (!spec.startsWith(".")) return null
  const parts = fromRel.split("/").slice(0, -1)
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") { parts.pop(); continue }
    parts.push(seg)
  }
  const base = parts.join("/")
  const js2ts = base.replace(/\.jsx?$/, (e) => (e === ".js" ? ".ts" : ".tsx"))
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, js2ts, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (byRel.has(cand)) return byRel.get(cand)
  }
  return null
}

/** The rel paths that DECLARE `name`, as exported by `file`. A re-exporter is
 *  an importer, not a declarer: `export { X } from "./m"` inherits X's origin
 *  from `./m` rather than claiming it, and `export *` is searched the same way.
 *  Returns EMPTY when this file does not account for the name at all -- it
 *  neither declares it, lists it, nor reaches it through a re-export. An
 *  unaccounted name must not become an origin: doing so silences the very file
 *  that mentions it, which turned a barrel containing one comment into a false
 *  positive. The caller decides what an unaccounted name falls back to. */
function originOf(file, name, byRel, seen = new Set()) {
  if (exportDeclNames(file.text).includes(name)) return new Set([file.rel])
  if (seen.has(file.rel)) return new Set()
  seen.add(file.rel)
  const origins = new Set()
  for (const e of exportListEntries(file.text)) {
    if (e.name !== name) continue
    const target = e.from ? resolveModule(e.from, file.rel, byRel) : null
    if (!target) { origins.add(file.rel); continue }
    for (const o of originOf(target, name, byRel, seen)) origins.add(o)
  }
  for (const m of file.text.matchAll(EXPORT_STAR)) {
    const target = resolveModule(m[1], file.rel, byRel)
    if (!target || seen.has(target.rel)) continue
    for (const o of originOf(target, name, byRel, seen)) origins.add(o)
  }
  return origins
}

/** Exports of `file`, following `export * from "./sibling"` into the sibling and
 *  recursing, each name paired with the module(s) that DECLARE it. A name that
 *  resolves to no declaring module falls back to `file`, so an unresolvable
 *  chain still has an origin instead of making every mention look legitimate.
 *  `seen` terminates a re-export cycle. */
function exportedNamesDeep(file, byRel, seen = new Set([file.rel])) {
  const origins = new Map()
  const add = (name, rels) => {
    if (!origins.has(name)) origins.set(name, new Set())
    for (const r of rels) origins.get(name).add(r)
  }
  for (const name of exportedNames(file.text)) {
    const o = originOf(file, name, byRel)
    add(name, o.size ? o : new Set([file.rel]))
  }
  for (const m of file.text.matchAll(EXPORT_STAR)) {
    const target = resolveModule(m[1], file.rel, byRel)
    if (!target || seen.has(target.rel)) continue
    seen.add(target.rel)
    for (const [name, rels] of exportedNamesDeep(target, byRel, seen)) add(name, rels)
  }
  return origins
}

/** An entry point is a production file like any other: a name it imports and
 *  then calls, composes or narrows IS used on a production path. Only the
 *  statements that merely NAME what it re-exports are a false mention, so those
 *  spans are blanked -- spaces, newlines kept, so blanking can never join two
 *  tokens into one word -- and the rest of the entry is scanned like any other
 *  file. Blanking the whole entry is what reported
 *  `compaction#selectShadowableRange`, imported at :8, re-exported at :12 and
 *  called at :92. */
function withoutReExportStatements(text) {
  let out = text
  for (const shared of [EXPORT_LIST, EXPORT_STAR]) {
    // A fresh copy per use: the shared regexes are also read by matchAll.
    out = out.replace(new RegExp(shared.source, shared.flags), (m) => m.replace(/[^\n]/g, " "))
  }
  return out
}

/** A name is "used" when some NON-TEST file -- other than the module(s) that
 *  DECLARE it -- mentions it as a word. Package scoping is deliberately absent:
 *  a symbol imported relatively and called inside its own package is used on a
 *  production path just as much as one imported by a sibling package. The entry
 *  point is scanned too, minus its re-export statements: those name everything
 *  the package re-exports without using any of it. */
function scanUnusedExports(files) {
  const prod = files.filter((f) => !f.test)
  const byRel = new Map(prod.map((f) => [f.rel, f]))
  const findings = []
  for (const entry of prod.filter((f) => /^packages\/[^/]+\/src\/index\.ts$/.test(f.rel))) {
    const pkg = "@i-harness/" + entry.rel.split("/")[1]
    const entryText = withoutReExportStatements(entry.text)
    for (const [name, origins] of exportedNamesDeep(entry, byRel)) {
      const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
      const used = prod.some((f) => !origins.has(f.rel) && word.test(f.rel === entry.rel ? entryText : f.text))
      if (!used) findings.push({ kind: "unused-export", subject: `${pkg}#${name}`, evidence: entry.rel })
    }
  }
  return findings
}

SCANNERS.push(scanUnusedExports)

// ------------------------------------------- class 2: event with no producer
const EVENT_LITERAL = /"([a-z][a-z0-9-]*\/[a-z0-9-]+)"/g
const EVENT_DECL_FILE = /(^|\/)(events?|manifest|public-event-manifest)\.ts$/
/** A line whose leading tokens DECLARE a type: `type X`, `export interface X`,
 *  `declare type X`. The identifier after the keyword is required, because the
 *  object-literal property `type: "compaction/attempt"` -- the shape of every
 *  real emit site in this repo -- otherwise reads as a type declaration and
 *  silences its own event. */
const TYPE_DECL_LINE = /^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+[A-Za-z_$]/

/** Is this occurrence of `"name"` a USE rather than a declaration? A union
 *  member declares, inline (`= "a" | "b"`) or on its own `| "a"` continuation
 *  line -- telemetry/types.ts lists every code that way, and counting those
 *  lines as producers reported zero findings for a manifest that does contain a
 *  producerless code. A literal on the value side of an `=` is a use even when
 *  its line also carries a type annotation: `const e: E = "beta/change"`
 *  assigns one, so vetoing the whole line on `:\s*[A-Z]` (as a line-level rule
 *  does) reports the fixture's own producer as producerless.
 *
 *  Judgements this cannot make, in the spirit of the header: a quoted name
 *  inside a TRAILING comment still reads as a use (a missed finding, never an
 *  invented one; there is none in this tree), and only the first occurrence on
 *  a line is classified. */
function isProducerLine(ln, name) {
  const at = ln.indexOf(`"${name}"`)
  if (at < 0) return false
  if (/^\s*(?:\/\/|\*|\/\*)/.test(ln)) return false
  if (/\|\s*$/.test(ln.slice(0, at))) return false
  return !TYPE_DECL_LINE.test(ln)
}

/** An event name is "produced" when a NON-TEST file other than the file that
 *  declares the union contains the same string literal outside a type position.
 *  A union member is a declaration; a literal in a value position is a use. */
function scanProducerlessEvents(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const decl of prod.filter((f) => EVENT_DECL_FILE.test(f.rel))) {
    const names = new Set([...decl.text.matchAll(EVENT_LITERAL)].map((m) => m[1]))
    for (const name of names) {
      const produced = prod.some((f) => f !== decl && f.text.split(/\r?\n/).some((ln) => isProducerLine(ln, name)))
      if (!produced) findings.push({ kind: "producerless-event", subject: name, evidence: decl.rel })
    }
  }
  return findings
}

// ------------------------------------------------ class 3: flag never read
const FLAG_CASE = /case\s+"(--[a-z0-9-]+)"\s*:\s*flags\.([A-Za-z_$][\w$]*)\s*=/g

/** `text` with its string literals and comments blanked -- spaces, never
 *  deletion, and newlines kept, so blanking can neither join two tokens nor
 *  destroy line structure. A `--yes` named in a `--help` usage string, in a
 *  header comment or in block-comment prose is a mention, not a read of
 *  `flags.yes`. What it does not model: a `/` pair inside a regex literal starts
 *  a comment, and a whole template literal is blanked including its `${...}`. */
function codeOnly(text) {
  let out = ""
  let quote = null
  let block = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const d = text[i + 1]
    if (c === "\n") { out += c; continue }
    if (block) {
      if (c === "*" && d === "/") { block = false; out += "  "; i++; continue }
      out += " "
      continue
    }
    if (quote !== null) {
      if (c === "\\") { out += "  "; i++; continue }
      if (c === quote) quote = null
      out += " "
      continue
    }
    if (c === "/" && d === "*") { block = true; out += "  "; i++; continue }
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++ }
      if (i < text.length) out += "\n"
      continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += " "; continue }
    out += c
  }
  return out
}

/** A flag is "read" when an occurrence of its field name SURVIVES the two shapes
 *  that DEFINE a field rather than use it: a key or type annotation, required or
 *  optional (`yes:`, `prompt?:`), and an assignment target (`yes =`, but not
 *  `yes ===`, which compares). Blanking the occurrence rather than the whole
 *  line is the point: a line-level `field:` exclusion cannot match the `?` in
 *  `prompt?: string`, so every OPTIONAL field was certified read by its own
 *  declaration and this scanner's one real finding came out right by luck. A
 *  read sharing a line with a key still counts: `{ prompt: flags.prompt }`
 *  blanks the key and keeps the read. */
function scanUnreadFlags(files) {
  const findings = []
  for (const f of files.filter((x) => !x.test)) {
    const assigned = new Map()
    for (const m of f.text.matchAll(FLAG_CASE)) assigned.set(m[2], m[1])
    if (assigned.size === 0) continue
    const lines = codeOnly(f.text).split(/\r?\n/)
    for (const [field, flag] of assigned) {
      // `$` is regex syntax AND a legal identifier character: escape it.
      const word = field.replace(/[$]/g, "\\$")
      const key = new RegExp(`\\b${word}\\s*\\??\\s*:`, "g")
      const assign = new RegExp(`\\b${word}\\s*=(?!=|>)`, "g")
      const read = lines.some((ln) => new RegExp(`\\b${word}\\b`).test(ln.replace(key, " ").replace(assign, " ")))
      if (!read) findings.push({ kind: "unread-flag", subject: flag, evidence: f.rel })
    }
  }
  return findings
}

SCANNERS.push(scanProducerlessEvents, scanUnreadFlags)


// ------------------------------ shared lexical helpers (classes 4 and 5)
/** `text` from `i` with whitespace and comments skipped, strings NOT skipped.
 *  Both new scanners must read past prose -- every member of this repo's
 *  capability union carries a trailing `//` comment, and a settings document is
 *  half comments -- while their quoted values are still data. `codeOnly`
 *  (class 3) blanks strings as well, and these two classes are looking for
 *  exactly those strings, so it does not fit them. */
function skipTrivia(text, i) {
  for (;;) {
    if (i >= text.length) return i
    const c = text[i]
    const d = text[i + 1]
    if (/\s/.test(c)) { i++; continue }
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") i++; continue }
    if (c === "/" && d === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue }
    return i
  }
}

/** The string literal that opens at `i` (its quote is `text[i]`), escape
 *  sequences honoured; `end` is the index just past the closing quote. */
function readQuoted(text, i) {
  const q = text[i]
  let j = i + 1
  while (j < text.length && text[j] !== q) { if (text[j] === "\\") j++; j++ }
  return { value: text.slice(i + 1, j), end: j + 1 }
}

// ------------------------------------- class 4: capability never pushed
/** The capability INVENTORY is a string-literal union TYPE, not a file name.
 *  The drafted anchor `/(^|\/)(caps|capabilities)\.ts$/` matches no file in this
 *  repo -- the real inventory is `SlashCapability` in
 *  packages/tui/src/app/slash/types.ts -- and no quoted `"word"` in the real
 *  declaring file is a capability either, so the drafted scanner reported
 *  0 findings over a tree that holds three unpushed capabilities: a broken rule
 *  reading as a clean sweep. The name pattern keeps `Cap`/`Caps`/`Capability`/
 *  `Capabilities` (the fixture's `Cap`, the real `SlashCapability`) and rejects
 *  `CapabilityStatus`, which is a status union, not an inventory. */
const CAP_UNION_DECL = /^export\s+type\s+([A-Za-z_$][\w$]*)\s*=/gm
const CAP_UNION_NAME = /(?:Cap|Caps|Capability|Capabilities)$/
const CAP_PUSH = /\.push\(\s*"([^"]+)"/g

/** The members of the union whose `=` ends at `i`: it reads `| "x"` pairs across
 *  comments and newlines and stops at the first token that is neither. Only the
 *  union's own literals become members -- reading every quoted string in the file
 *  (the drafted rule) would turn the dozens of other quoted strings in tui's
 *  types.ts (`"agent"`, `"skills"`, `"jump"`, ...) into capabilities. */
function unionMembers(text, i) {
  const members = []
  for (;;) {
    i = skipTrivia(text, i)
    const c = text[i]
    if (c === "|") { i++; continue }
    if (c === '"' || c === "'") { const s = readQuoted(text, i); members.push(s.value); i = s.end; continue }
    break
  }
  return [...new Set(members)]
}

/** A capability is "pushed" when a production file adds it to a capability list
 *  with `.push("name")` -- tui's loop.ts `slashCapabilities()` is the only such
 *  site here -- never when it is merely named. A union that NO member of is ever
 *  pushed is not a push inventory at all: plugin-registry's `Capability` is
 *  `skills`/`commands`/`mcp` sniffed off disk by `existsSync`, and reporting its
 *  three members would invent three findings (measured), so such a union is
 *  skipped. The cost is the mirror image and is stated: a union that is entirely
 *  unpushed is a silent miss, never an invented finding.
 *
 *  The drafted `CAP_PUSH` carried no `g` flag, so its `matchAll` threw
 *  `TypeError: String.prototype.matchAll called with a non-global RegExp
 *  argument` the moment a declaration file matched -- measured, by running the
 *  drafted snippet: the empty declaration set is the only reason that defect
 *  stayed invisible. */
function scanUnpushedCapabilities(files) {
  const prod = files.filter((f) => !f.test)
  const pushed = new Set()
  for (const f of prod) for (const m of f.text.matchAll(CAP_PUSH)) pushed.add(m[1])
  const findings = []
  for (const decl of prod) {
    for (const m of decl.text.matchAll(CAP_UNION_DECL)) {
      if (!CAP_UNION_NAME.test(m[1])) continue
      const members = unionMembers(decl.text, m.index + m[0].length)
      if (members.length === 0 || !members.some((n) => pushed.has(n))) continue
      for (const n of members) {
        if (!pushed.has(n)) findings.push({ kind: "unpushed-capability", subject: n, evidence: decl.rel })
      }
    }
  }
  return findings
}

// ------------------------------------ class 5: setting never consulted
/** The settings schema here is a DEFAULTS DOCUMENT, not a file named
 *  `schema.ts`: the drafted anchor `/(^|\/)(schema|settings-schema)\.ts$/`
 *  matches no file in this repo (the schema is `SETTINGS_DEFAULTS` in
 *  packages/settings/src/index.ts), and no quoted dotted key exists anywhere in
 *  the production tree -- no `"compaction.auto":` shape at all. So the drafted
 *  scanner reported 0 findings over 33 declared key paths: a broken rule reading
 *  as a clean sweep. The name anchor is kept for the fixture's shape; the export
 *  anchor is added for the real one. */
const SETTINGS_SCHEMA_FILE = /(^|\/)(schema|settings-schema)\.ts$/
const SETTINGS_DEFAULTS_DECL = /export const [A-Z0-9_]*DEFAULTS\b[^=]*=\s*\{/
const SETTING_KEY = /"([a-z][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]+)"\s*:/g

/** Skip one object-literal VALUE. Strings, templates and comments are honoured,
 *  so a `,` or `}` inside a separator string or a comment cannot end it. */
function skipValue(text, i) {
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") i++; continue }
    if (c === "/" && d === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue }
    if (c === '"' || c === "'" || c === "`") { i = readQuoted(text, i).end; continue }
    if (c === "{" || c === "[" || c === "(") { depth++; i++; continue }
    if (c === "}" || c === "]" || c === ")") { if (depth === 0) return i; depth--; i++; continue }
    if (c === "," && depth === 0) return i
    i++
  }
  return i
}

/** The key/value entries of the object literal that opens at `open`. A quoted
 *  key is one key (`"compaction.auto"`), a nested object recurses, anything else
 *  is a leaf. `end` is the index just past the closing `}`. */
function objectEntries(text, open) {
  const entries = []
  let i = skipTrivia(text, open + 1)
  while (i < text.length && text[i] !== "}") {
    let key
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const s = readQuoted(text, i)
      key = s.value
      i = skipTrivia(text, s.end)
    } else {
      let j = i
      while (j < text.length && /[\w$]/.test(text[j])) j++
      key = text.slice(i, j)
      i = skipTrivia(text, j)
    }
    if (text[i] !== ":") break
    i = skipTrivia(text, i + 1)
    if (text[i] === "{") {
      const inner = objectEntries(text, i)
      entries.push({ key, kids: inner.entries })
      i = skipTrivia(text, inner.end)
    } else {
      entries.push({ key, kids: null })
      i = skipValue(text, i)
    }
    if (text[i] === ",") { i = skipTrivia(text, i + 1); continue }
    break
  }
  return { entries, end: i + 1 }
}

/** Dotted paths of every leaf entry -- the settings DOCUMENT's key paths
 *  (`compaction.auto`, `tui.prefs.statusLine.mode`). This is the half the
 *  drafted rule could not see: it recognised only keys already written
 *  dotted-and-quoted, and the real document is nested objects. */
function leafKeyPaths(entries, prefix = []) {
  const out = []
  for (const e of entries) {
    const path = [...prefix, e.key]
    if (e.kids && e.kids.length > 0) out.push(...leafKeyPaths(e.kids, path))
    else out.push(path.join("."))
  }
  return out
}

/** A key is CONSULTED when a production file other than the one that declares
 *  it reads it: as the quoted key (`s["notify.on"]`, the drafted test) or as a
 *  property access ending in the key's LEAF (`settings.get().compaction.auto`).
 *  The drafted test was string-only, and this repo reads settings as properties,
 *  so it would have reported `compaction.auto` -- read at apps/cli/src/index.ts:
 *  215 -- as unconsulted, an invented finding. Both tests are mention-based, as
 *  class 3's is: a mention counts, so a reported key is strong evidence and an
 *  unreported one is not proof that it is read. The leaf name is regex-escaped
 *  the way `scanUnusedExports` escapes it, since `$` is both regex syntax and a
 *  legal identifier character. */
function scanUnconsultedSettings(files) {
  const prod = files.filter((f) => !f.test)
  const findings = []
  for (const decl of prod.filter((f) => SETTINGS_SCHEMA_FILE.test(f.rel) || SETTINGS_DEFAULTS_DECL.test(f.text))) {
    const keys = new Set([...decl.text.matchAll(SETTING_KEY)].map((m) => m[1]))
    const m = decl.text.match(SETTINGS_DEFAULTS_DECL)
    if (m) {
      const open = decl.text.indexOf("{", decl.text.indexOf(m[0]))
      for (const key of leafKeyPaths(objectEntries(decl.text, open).entries)) keys.add(key)
    }
    for (const key of keys) {
      const leaf = key.slice(key.lastIndexOf(".") + 1).replace(/[$]/g, "\\$")
      const prop = new RegExp(`\\.\\s*${leaf}\\b`)
      const read = prod.some((f) => f !== decl && (f.text.includes(`"${key}"`) || f.text.includes(`'${key}'`) || prop.test(f.text)))
      if (!read) findings.push({ kind: "unconsulted-setting", subject: key, evidence: decl.rel })
    }
  }
  return findings
}

SCANNERS.push(scanUnpushedCapabilities, scanUnconsultedSettings)

SELF_TEST_CASES.push({
  name: "class 1: an export only a test imports is a finding",
  expect: ["@i-harness/alpha#Orphan", "@i-harness/alpha#OnlyAType"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/alpha#"))
  },
})

SELF_TEST_CASES.push({
  name: "class 1: an export a production file imports is NOT a finding",
  expect: [],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s === "@i-harness/alpha#Wired")
  },
})

SELF_TEST_CASES.push({
  name: "class 1: a same-package relative consumer counts as use",
  expect: [],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s === "@i-harness/alpha#RelativelyUsed")
  },
})

SELF_TEST_CASES.push({
  name: "class 1: export * is followed, and following it does not mark everything used",
  expect: ["@i-harness/epsilon#UnusedReExport"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s === "@i-harness/epsilon#ReExported" || s === "@i-harness/epsilon#UnusedReExport")
  },
})

SELF_TEST_CASES.push({
  name: "index: a dot-directory is never walked",
  expect: [],
  run(root) {
    return indexTree(root)
      .map((f) => f.rel)
      .filter((rel) => rel.split("/").includes(".hidden"))
  },
})

SELF_TEST_CASES.push({
  name: "class 1: a named re-export is attributed to its declarer",
  expect: [],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/eta#"))
  },
})

// Two assertions in one exact-set expectation, because both describe what the
// ENTRY's own text contributes: `TypeOnlyExport` arrives only through the
// entry's `export { type ... }` list (so dropping the modifier strip loses the
// clean name AND produces the phantom), and `EntryCallSite` is imported,
// re-exported and CALLED by the entry (so excluding the whole entry reports a
// name on a production path).
SELF_TEST_CASES.push({
  name: "class 1: an inline type modifier does not leak into the subject",
  expect: ["@i-harness/epsilon#TypeOnlyExport", "@i-harness/epsilon#UnusedReExport"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/epsilon#"))
  },
})

SELF_TEST_CASES.push({
  name: "class 2: an event only declared and read, never constructed, is a finding",
  expect: ["beta/ghost"],
  run(root) {
    return scanProducerlessEvents(indexTree(root)).map((f) => f.subject)
  },
})

SELF_TEST_CASES.push({
  name: "class 3: a flag parsed into the flags object and never read is a finding",
  expect: ["--verbose", "--yes"],
  run(root) {
    return scanUnreadFlags(indexTree(root)).map((f) => f.subject)
  },
})

SELF_TEST_CASES.push({
  name: "class 2: a union member on its own continuation line is a declaration, not a producer",
  expect: ["beta/ghost"],
  run(root) {
    return scanProducerlessEvents(indexTree(root)).map((f) => f.subject)
  },
})

SELF_TEST_CASES.push({
  name: "class 3: an optional field that IS read is not a finding (negative control)",
  expect: [],
  run(root) {
    return scanUnreadFlags(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s === "--strict")
  },
})

SELF_TEST_CASES.push({
  name: "class 4: a capability in the union that is never pushed is a finding",
  expect: ["beta-cap", "plan-mode"],
  run(root) { return scanUnpushedCapabilities(indexTree(root)).map((f) => f.subject) },
})

SELF_TEST_CASES.push({
  name: "class 5: a settings key with a schema entry and no reader is a finding",
  expect: ["compaction.auto", "ui.fontSizePx"],
  run(root) { return scanUnconsultedSettings(indexTree(root)).map((f) => f.subject) },
})

function runSelfTest() {
  const root = buildFixture()
  let ok = 0
  try {
    for (const c of SELF_TEST_CASES) {
      let got
      try {
        got = c.run(root).slice().sort().join(",")
      } catch (err) {
        // A case whose scanner does not exist yet must report FAIL and let the
        // harness finish: a bare ReferenceError would abort before `N/M` prints,
        // so the red state Tasks 2-4 rely on would be unreachable.
        console.log(`  FAIL ${c.name}\n       ${err && err.message ? err.message : String(err)}`)
        continue
      }
      const want = c.expect.slice().sort().join(",")
      if (got === want) { ok++; console.log(`  ok   ${c.name}`) }
      else console.log(`  FAIL ${c.name}\n       expected [${want}]\n       got      [${got}]`)
    }
  } finally {
    if (!process.env.KEEP_FIXTURE) rmSync(root, { recursive: true, force: true })
    else console.log(`  fixture kept at ${root}`)
  }
  console.log(`\nself-test: ${ok}/${SELF_TEST_CASES.length} ok`)
  return { ok, total: SELF_TEST_CASES.length }
}

if (args.includes("--self-test")) {
  const { ok, total } = runSelfTest()
  process.exit(ok === total && total > 0 ? 0 : 1)
}

// ------------------------------------------------------------------ file index
function collectTs(dir, out = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "lib") continue
    // A dot-directory is gitignored scratch or metadata, never repo source:
    // walking .superpowers/ made the file count track scratch, not the repo.
    if (e.name.startsWith(".") && e.isDirectory()) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectTs(full, out)
    else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

function isTestPath(abs) {
  return /[\\/]tests?[\\/]/.test(abs) || /\.test\.tsx?$/.test(abs)
}

/** One pass over the tree. `rel` always uses forward slashes so scanners can
 *  match on stable path prefixes regardless of platform. */
function indexTree(root) {
  return collectTs(root).map((abs) => {
    let text = ""
    try { text = readFileSync(abs, "utf8") } catch { /* unreadable file is not a finding */ }
    return { abs, rel: relative(root, abs).split("\\").join("/"), test: isTestPath(abs), text }
  })
}

// ----------------------------------------------------------------------- main
if (!args.includes("--self-test")) {
  const files = indexTree(resolve(argVal("--root", ROOT)))
  const findings = SCANNERS.flatMap((s) => s(files))

  if (AS_JSON) {
    console.log(JSON.stringify({ root: resolve(argVal("--root", ROOT)), findings }, null, 2))
  } else {
    console.log(`reachability: ${files.length} ts files, ${findings.length} finding(s)\n`)
    for (const f of findings) console.log(`  ${f.kind.padEnd(22)} ${f.subject.padEnd(52)} ${f.evidence}`)
  }
  process.exit(0)
}
