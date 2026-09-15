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

  // class 3: `--yes` is parsed into flags and never read; `--model` is read.
  put("apps/tool/src/index.ts", [
    "type Flags = { yes: boolean; model?: string }",
    "const flags: Flags = { yes: false }",
    'case "--yes": flags.yes = true; break',
    'case "--model": flags.model = next(); break',
    "run(flags.model)",
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

/** The line with its string literals and trailing comment blanked -- spaces,
 *  never deletion, so blanking cannot join two tokens into one word. A `--yes`
 *  named in a `--help` usage string, or in the header comment that documents
 *  it, is a mention and not a read of `flags.yes`: counting those mentions is
 *  what hid this repo's own parsed-but-never-read flag. What it does not model:
 *  a `/` pair inside a regex literal reads as a comment start (no such line
 *  matches a flag field here), and a read sharing a line with `field:` or
 *  `field =` is still discounted by the caller below. */
function codeOnly(ln) {
  let out = ""
  let quote = null
  for (let i = 0; i < ln.length; i++) {
    const c = ln[i]
    if (quote !== null) {
      if (c === "\\") { out += "  "; i++; continue }
      if (c === quote) quote = null
      out += " "
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += " "
    } else if (c === "/" && ln[i + 1] === "/") {
      break
    } else {
      out += c
    }
  }
  return out
}

/** A flag is "read" when its field name appears somewhere in the same file other
 *  than its declaration, its initialiser and the `case` that assigns it. */
function scanUnreadFlags(files) {
  const findings = []
  for (const f of files.filter((x) => !x.test)) {
    const assigned = new Map()
    for (const m of f.text.matchAll(FLAG_CASE)) assigned.set(m[2], m[1])
    for (const [field, flag] of assigned) {
      const lines = f.text.split(/\r?\n/)
      const read = lines.some((ln) => {
        if (ln.includes(`case "${flag}"`)) return false
        const code = codeOnly(ln)
        if (new RegExp(`\\b${field}\\s*:`).test(code)) return false
        if (new RegExp(`\\b${field}\\s*=`).test(code)) return false
        return new RegExp(`\\b${field}\\b`).test(code)
      })
      if (!read) findings.push({ kind: "unread-flag", subject: flag, evidence: f.rel })
    }
  }
  return findings
}

SCANNERS.push(scanProducerlessEvents, scanUnreadFlags)

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
  expect: ["--yes"],
  run(root) {
    return scanUnreadFlags(indexTree(root)).map((f) => f.subject)
  },
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
