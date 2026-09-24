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
// The sharpest instance of the first limit is ARGUMENT ROUTING: every scanner is a
// name/string test, so a flag that is parsed and then handed to the WRONG consumer
// reads exactly like one that is wired (M1 Phase B Task 3's defect class). No class
// here can see it and no fixture can make one see it -- it is invisible to this tool
// by construction, and it is guarded by tests, not by the gate. A passing `--gate`
// must not be read as covering it.
//
// Usage:
//   node scripts/audit/check-reachability.mjs                 # human table
//   node scripts/audit/check-reachability.mjs --json          # machine readable
//   node scripts/audit/check-reachability.mjs --digest        # the row-set digest
//   node scripts/audit/check-reachability.mjs --self-test     # prove the scanners
//   node scripts/audit/check-reachability.mjs --seed-baseline   # (re)write the baseline
//   node scripts/audit/check-reachability.mjs --gate             # fail on NEW rows only
//   node scripts/audit/check-reachability.mjs --digest --json    # --digest wins: digest only, no JSON

import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"

const ROOT = resolve(process.argv[1], "../../..")
const args = process.argv.slice(2)

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
  // The FIRST line is M2 Task 4's half of the comment fixture, and M79 Task 6
  // reversed its meaning. The only mention of `BetaThing` anywhere in this
  // FIXTURE is that COMMENT, in another package -- and it USED to be enough to
  // suppress `@i-harness/beta#BetaThing`, because the word test ran over raw
  // file text. Since the fix the comment is stripped before that test, so the
  // row appears and the case that pins it asserts the row.
  put("packages/alpha/src/index.ts", [
    "// BetaThing is mentioned only here, in a comment.",
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
  // declaring file, so nothing would pin the `| "name"` clause. Measured, M1's
  // fix wave: deleting that clause fails this case AND moves the real tree from
  // 525 rows to 524 -- class 2's single row, `retry/start`, disappears. The
  // fixture half was measured when the clause was written; the real-tree half
  // was not, and is, as of the fix wave.
  put("packages/beta/src/types.ts", [
    "export type EventKind =",
    '  | "beta/ghost"',
    "",
  ].join("\n"))

  // --- Added by M2 Task 4, for the cross-package case below.
  // A `beta` ENTRY is what class 1 needs before it can report anything for that
  // package at all; the fixture had none, because `beta` existed only for the
  // class-2 files above. The second half -- a COMMENT in another package that
  // merely NAMES the export -- is what the case below measures; M79 Task 6
  // turned that case around, so the comment is now what the row SURVIVES.
  put("packages/beta/src/index.ts", "export type BetaThing = string\n")

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

  // --- Added by M79 Task 6, for the comment-stripping fix (spec §1.4 d2).
  // (i) A comment in the ENTRY ITSELF. `EntryCommentOnly` is declared in
  // `impl.ts` and re-exported by the entry, and the comment is the only mention
  // OUTSIDE both of those -- so the raw-text word test read that comment as a
  // consumer and retired the package's row. This element pins the ENTRY half of
  // the fix: dropping comment-stripping from the `entryText` path ALONE reddens
  // the case below, while the cross-package element (`BetaThing`, in
  // `packages/alpha/src/index.ts`) stays green -- that one rides the per-file
  // path, so the two elements fail on DIFFERENT mutations.
  put("packages/zeta/src/impl.ts", "export function EntryCommentOnly() { return 1 }\n")
  put("packages/zeta/src/index.ts", [
    "// EntryCommentOnly is named only here, in a comment in the entry.",
    'export { EntryCommentOnly } from "./impl.ts"',
    "",
  ].join("\n"))
  // (ii) The over-stripping GUARD, added with the case that pins it: a mention
  // inside a STRING LITERAL must still retire the row. Class 1 keeps string
  // contents on purpose -- an export consumed through `import *` plus a string
  // key is really consumed, so blanking strings would invent rows -- and
  // `OnlyInAString` appears nowhere but that literal in `keys.ts`. Reusing
  // `codeOnly` here, which blanks strings too, reports it and reddens the case.
  // `RealOrphan` is the case's positive control: the expectation is an exact
  // set, so a scanner that never looked at this package would leave it empty
  // and fail rather than pass on an absence.
  put("packages/psi/src/index.ts", [
    "export function OnlyInAString() { return 1 }",
    "export function RealOrphan() { return 2 }",
    "",
  ].join("\n"))
  put("packages/psi/src/keys.ts", 'export const KEY = "OnlyInAString"\n')

  // class 4: `plan-mode` appears in the capability union but is never pushed.
  // Added by M1's fix wave (I2): the union file is a real module, so it also
  // carries UNRELATED quoted strings -- a path, a package name, a plain word --
  // beside the union. Reading every quoted string in the file (the drafted
  // class-4 rule) invents all three as unpushed capabilities; on the real tree
  // that loosening moves 525 rows to 551 and `unpushed-capability` from 3 to 29
  // (measured). Without these literals the file held nothing but the union, so
  // the strict `unionMembers` reader and the loose one agreed exactly and no
  // case could tell them apart.
  put("packages/gamma/src/caps.ts", [
    'export type Cap = "plan-mode" | "vim-mode"',
    'export const CAP_CONTRACT = "../../contracts.ts"',
    'export const CAP_SETTINGS = "@i-harness/settings"',
    'export const CAP_MARKET = "marketplace"',
    "",
  ].join("\n"))
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

  // --- Added by M1's fix wave (final whole-branch review, I2 and Deferred item
  // 18). Each element below exists to make ONE loosening visible to
  // `--self-test`; the mutation it turns red is named in the comment.

  // I2 survivor, class 2: an inline TYPE DECLARATION in a file that does not
  // declare the union NAMES the event without producing it. Without this file
  // the ghost's only non-declaring occurrences are a test file (excluded) and
  // the `| "beta/ghost"` continuation line in types.ts (rejected by the leading
  // pipe rule), so deleting the `TYPE_DECL_LINE` veto changed no expectation.
  put("packages/beta/src/alias.ts", 'export type GhostAlias = "beta/ghost"\n')

  // I2 survivor, class 5: a key read ONLY as a quoted key. `syncWindow` has no
  // dot, so there is no `.syncWindow` for the reader's property half to find and
  // the quoted-key half is the only test that clears it. Every other fixture
  // read is also visible to the property half, so deleting the quoted-key half
  // changed no expectation.
  put("packages/mu/src/defaults.ts", 'export const MU_DEFAULTS = { syncWindow: 5 }\n')
  put("packages/mu/src/read.ts", 'const w = s["syncWindow"]\n')

  // I2 survivor, class 3: a read that is NOT a dotted property access. `--quiet`
  // is destructured out of the flags object and passed on, so the surviving word
  // has no `.` in front of it; every other fixture read is `flags.<field>`, so
  // requiring a `.` before the read changed no expectation.
  put("apps/tool-c/src/index.ts", [
    "type Flags = { quiet?: boolean }",
    "const flags: Flags = {}",
    'case "--quiet": flags.quiet = true; break',
    "const { quiet } = flags",
    "run(quiet)",
  ].join("\n"))

  // Deferred item 18: a `*_DEFAULTS` declaration that carries a TYPE ANNOTATION,
  // so the first `{` at or after the declaration's start is the ANNOTATION's.
  // Anchoring there parses `annotationOnly` as a settings key and never sees
  // `realKey`; anchoring on the initialiser does the opposite.
  put("packages/nu/src/defaults.ts", 'export const NU_DEFAULTS: { annotationOnly: number } = { realKey: 5 }\n')

  // The class-5 anchor's `export` requirement, PINNED. Dropping the `export`
  // keyword is this repo's PRESCRIBED remediation for an unused export -- and it
  // used to blind class 5, so the tool reported its own blindness as PROGRESS:
  // findings fall, `gone` rises, `--gate` still exits 0 and `--self-test` still
  // reads 36/36. A DEFAULTS document is one whether or not it is exported.
  put("packages/xi/src/defaults.ts", 'const XI_DEFAULTS = { xiKey: 1 }\n')

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
 *  the package re-exports without using any of it.
 *
 *  The word test reads COMMENT-STRIPPED text (`commentsBlanked`), for the entry
 *  as well as for every other production file -- the entry's copy is stripped
 *  BEFORE its re-export statements are blanked, so the two mention-only shapes
 *  compose. Until M79 Task 6 it read the raw file, comments included, and a
 *  comment that merely NAMED an export therefore retired that package's row: a
 *  false negative, measured twice on this tree (M77 and M78, both times the
 *  comment was reworded rather than the reader fixed). STRING LITERALS ARE
 *  KEPT, deliberately: an export consumed through `import *` plus a string key
 *  is really consumed, so blanking strings would manufacture rows, which is the
 *  worse direction of error.
 *
 *  Two structural blind spots are LEFT IN PLACE deliberately. M1's ruling R-L
 *  recorded the second and refused to fix the scanner mid-flight, because either
 *  fix moves the row set, the digest and the published precision sample; M2
 *  Task 4 documented both here and fixed neither. What they mean for a reader:
 *  a clean class-1 result is NOT a clean bill for the package.
 *
 *  (1) ENTRY-ONLY. The loop below walks `packages/<pkg>/src/index.ts` and tests
 *      the names THAT ENTRY exports, so two shapes are invisible: (a) any file
 *      the entry never mentions, and every name it declares -- e.g.
 *      `packages/guard-approval/src/remember.ts` and
 *      `packages/sandbox-local/src/runner-failures.ts`; and (b) any name the
 *      entry reaches but does not export through itself -- e.g.
 *      `closeFileBackedConnections`
 *      (`packages/session-query/src/file-backed.ts:91`), which the entry imports
 *      at `:7` and calls at `:55` while re-exporting only its siblings (`:246`).
 *      Measured 2026-09-16: that name has no row.
 *
 *  (2) FROM-LESS LOCAL RE-EXPORT. A name the entry re-exports through a LOCAL
 *      `export { X }` list (no `from`) has no module to attribute it to, so
 *      `originOf` credits the ENTRY -- which leaves the file that DECLARES X
 *      inside the used-scan, where its own declaration satisfies the word test.
 *      Such a name is unreportable by this scanner **for the 39 names measured
 *      below**, and the rule is not general: whether the declaring file is left
 *      inside the used-scan depends on how the name reaches the entry, so a
 *      name can be unreportable here and reportable elsewhere. Measured
 *      2026-09-16 on this tree: 68 entries, 6 carrying a from-less list, 39
 *      names (`tui-core` 31, `fs-lock` 2, `sandbox-policy` 2,
 *      `session-persistence` 2, `attachment` 1, `core-agent` 1), and 0 of the
 *      39 appears in the row set. */
function scanUnusedExports(files) {
  const prod = files.filter((f) => !f.test)
  const byRel = new Map(prod.map((f) => [f.rel, f]))
  // ONE strip per production file for the whole scan, not one per question: the
  // same text is asked about once per (entry, name) pair -- 66 entries on this
  // tree, each with its export list (measured 2026-09-24) -- and stripping
  // inside the loop is what would blow up.
  const commentFree = new Map(prod.map((f) => [f.rel, commentsBlanked(f.text)]))
  const findings = []
  for (const entry of prod.filter((f) => /^packages\/[^/]+\/src\/index\.ts$/.test(f.rel))) {
    const pkg = "@i-harness/" + entry.rel.split("/")[1]
    // Strip comments FIRST, blank the re-export statements SECOND. The order is
    // the fix: the old `entryText` was raw text minus its re-export statements,
    // so every comment in the entry stayed alive as a mention.
    const entryText = withoutReExportStatements(commentFree.get(entry.rel))
    for (const [name, origins] of exportedNamesDeep(entry, byRel)) {
      const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
      const used = prod.some((f) => !origins.has(f.rel) && word.test(f.rel === entry.rel ? entryText : commentFree.get(f.rel)))
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

/** The ONE lexical state machine both text readers below share. It walks `text`
 *  character by character, tracking whether it is inside a string literal, a
 *  block comment or a line comment. Blanked spans are always spaces -- nothing
 *  is ever deleted -- and a newline passes through untouched, so a blanked span
 *  can neither join two tokens into one word nor destroy line structure.
 *
 *  `keepStrings` is the whole of the difference between the two callers: it
 *  decides whether a string literal's CONTENT is evidence or noise. Everything
 *  else -- comment handling, escapes, the newline rule -- is one implementation
 *  rather than two, so neither mode can drift from the other.
 *
 *  What it does not model, inherited unchanged by BOTH modes (M79 Task 6
 *  parameterised this function instead of forking it, so the limits are the same
 *  limits): a `/` pair inside a regex literal starts a comment, a quote inside
 *  one opens a string, and a template literal is one string, so its `${...}` is
 *  treated as string content in one mode and blanked in the other. A `//` inside
 *  a regex literal therefore blanks the rest of ITS line in both modes, but the
 *  two modes do not pay the same price for it. `codeOnly` (class 3) blanks
 *  string content by design, so a span lost there is a miss. `commentsBlanked`
 *  (class 1) KEEPS the strings, so what it blanks instead is REAL CODE: a
 *  mention that may be a use disappears, which turns the loss into an INVENTED
 *  row -- the worse of the two errors this file names elsewhere. Measured on
 *  this tree 2026-09-24: 5 files blank such a span (`task-board.ts`,
 *  `lsp/render.ts`, `plugin-registry/marketplaces.ts`, `rewind/path.ts`,
 *  `settings/index.ts`), every span inside a regex source and none containing an
 *  export name, so the direction is real and the consequence, today, is none. */
function blankLexical(text, keepStrings) {
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
      if (c === "\\") { out += keepStrings ? c + (d ?? "") : "  "; i++; continue }
      if (c === quote) quote = null
      out += keepStrings ? c : " "
      continue
    }
    if (c === "/" && d === "*") { block = true; out += "  "; i++; continue }
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++ }
      if (i < text.length) out += "\n"
      continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += keepStrings ? c : " "; continue }
    out += c
  }
  return out
}

/** `text` with its string literals AND comments blanked. A `--yes` named in a
 *  `--help` usage string, in a header comment or in block-comment prose is a
 *  mention, not a read of `flags.yes`. Class 3's reader, and byte-for-byte the
 *  function it always was: the shared machine is called with `keepStrings`
 *  false. */
function codeOnly(text) {
  return blankLexical(text, false)
}

/** `text` with its COMMENTS blanked and its string literals KEPT -- class 1's
 *  reader. A name mentioned only in a comment must not count as a consumer of an
 *  export, or a documented false negative retires that package's row; a name
 *  mentioned inside a string literal MUST count, because an export consumed
 *  through `import *` plus a string key is really consumed, and blanking strings
 *  would manufacture rows -- the worse of the two errors. The cost, stated: an
 *  export that NOTHING consumes but a stray string names keeps its row hidden,
 *  and the same goes for the machine's regex-literal limit above. */
function commentsBlanked(text) {
  return blankLexical(text, true)
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
// The `export` is OPTIONAL on purpose, and that is a correction of record.
//
// It used to be required, and the consequence was the worst kind: dropping the
// `export` keyword is this repo's PRESCRIBED remediation for an unused export
// (the bucket-B rule), so doing the right thing blinded this class. The tool then
// reported its own blindness as progress -- findings fall, `gone` rises against a
// frozen baseline, `--gate` exits 0, and `--self-test` stays green because the
// fixtures happened to be exported. Measured 2026-09-17 before the fix, on the
// real tree: blinding the anchor took findings 472 -> 464 with
// `unconsulted-setting` 8 -> 0.
//
// A DEFAULTS document is one whether or not it is exported: class 5 asks which
// setting keys nothing consults, and that question does not depend on the
// declaration's visibility. `\b` keeps the match from starting inside a longer
// identifier (`myconst X_DEFAULTS = {` must not match at `const`).
const SETTINGS_DEFAULTS_DECL = /\b(?:export\s+)?const [A-Z0-9_]*DEFAULTS\b[^=]*=\s*\{/
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
      // Anchor on the INITIALISER, not on the first `{` at or after the
      // declaration's start. With a type annotation -- `export const X_DEFAULTS:
      // { a: number } = { a: 1 }` -- that first brace is the ANNOTATION's, so the
      // annotation was parsed as the defaults document: `a` was emitted as a
      // settings key and the real ones were lost. `SETTINGS_DEFAULTS_DECL`
      // carries no `=` between the name and the initialiser's, so the first `=`
      // after the match start is the one that introduces the value.
      const eq = decl.text.indexOf("=", decl.text.indexOf(m[0]))
      const open = decl.text.indexOf("{", eq + 1)
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
  expect: ["compaction.auto", "realKey", "ui.fontSizePx", "xiKey"],
  run(root) { return scanUnconsultedSettings(indexTree(root)).map((f) => f.subject) },
})

// The five cases below were added by M1's fix wave (final whole-branch review,
// I2 and Deferred item 18). Honest accounting, because an earlier version of
// this comment claimed otherwise:
//
//   * Each one asserts the SAME exact set as the sibling case above it -- the
//     `run` and the `expect` are identical, and a case with the same `run` and
//     `expect` tests the same proposition. These five add NO independent check.
//   * What makes each loosening visible is the FIXTURE element added beside it
//     in `buildFixture`, not the case. That element is what turns the
//     PRE-EXISTING sibling red. Measured with `--self-test` on a copy whose
//     five added cases are deleted: the class-4 loosening still fails at
//     `12/13`, `TYPE_DECL_LINE` at `11/13`, the class-5 quoted-key half and the
//     DEFAULTS anchor at `12/13` each, and the class-3 `.`-before-the-read rule
//     at `12/13` -- every one of them on a pre-existing case, exit 1.
//   * The value of these cases is their NAME and the comment above each one:
//     that is the only record of which loosening its fixture element protects
//     against. Deleting them would delete the record without changing what the
//     self-test catches.
//   * The expectations are the unfiltered subject lists, the style the existing
//     cases use; the class-2 pair at `beta/ghost` already shared an assertion
//     before this wave.

// I2 survivor, class 4. Loosening caught: replacing the strict `unionMembers`
// reader with "every quoted string in the file" -- which then reports the three
// unrelated literals in `packages/gamma/src/caps.ts` and, on the real tree,
// moves 525 rows to 551.
SELF_TEST_CASES.push({
  name: "class 4: quoted strings beside the union are not capabilities",
  expect: ["beta-cap", "plan-mode"],
  run(root) { return scanUnpushedCapabilities(indexTree(root)).map((f) => f.subject) },
})

// I2 survivor, class 2. Loosening caught: deleting the `TYPE_DECL_LINE` veto,
// which makes the inline type declaration in `packages/beta/src/alias.ts` read
// as a producer of `beta/ghost`.
SELF_TEST_CASES.push({
  name: "class 2: a type declaration elsewhere names the event without producing it",
  expect: ["beta/ghost"],
  run(root) { return scanProducerlessEvents(indexTree(root)).map((f) => f.subject) },
})

// I2 survivor, class 5. Loosening caught: deleting the quoted-key half of the
// reader, which reports `syncWindow` -- a key with no dot, so the surviving
// property half has no `.syncWindow` anywhere to find.
SELF_TEST_CASES.push({
  name: "class 5: a key read as a quoted key rather than a property is consulted",
  expect: ["compaction.auto", "realKey", "ui.fontSizePx", "xiKey"],
  run(root) { return scanUnconsultedSettings(indexTree(root)).map((f) => f.subject) },
})

// I2 survivor, class 3. Loosening caught: requiring a `.` before the surviving
// field name, which reports `--quiet` -- read by destructuring, so its
// occurrence has no dot in front of it.
SELF_TEST_CASES.push({
  name: "class 3: a read that is not a dotted property access still counts",
  expect: ["--verbose", "--yes"],
  run(root) { return scanUnreadFlags(indexTree(root)).map((f) => f.subject) },
})

// Deferred item 18. Loosening caught: anchoring the DEFAULTS document on the
// first `{` at or after the declaration's start, which with a type annotation is
// the annotation's brace -- it reports `annotationOnly` and never sees `realKey`.
SELF_TEST_CASES.push({
  name: "class 5: a typed DEFAULTS declaration anchors on its initialiser",
  expect: ["compaction.auto", "realKey", "ui.fontSizePx", "xiKey"],
  run(root) { return scanUnconsultedSettings(indexTree(root)).map((f) => f.subject) },
})

// The cross-package comment, TURNED AROUND by M79 Task 6 rather than deleted.
// Class 1's `used` test USED to run its word regex over the RAW file text
// (`scanUnusedExports`, the `used` line) -- comments included -- so a comment
// that merely NAMED an export counted as a consumer and suppressed that
// package's row. The direction was a false NEGATIVE: a real orphan read as
// reachable. The test now reads comment-stripped text and keeps strings, so the
// row appears and this case asserts it.
//
// The fixture's `beta` entry AND the comment-only mention in
// `packages/alpha/src/index.ts` were ADDED by M2 Task 4 for this case. Neither
// half is decoration: with the entry present and no mention anywhere, the
// scanner emits `@i-harness/beta#BetaThing` (measured, red-first, before the
// comment was added), which is what the assertion now expects.
//
// The real-tree instance this case was written from has moved on, and saying so
// is the point. §6.2 of the baseline document
// (`docs/audit/2026-09-15-reachability-baseline.md §6.2`, the stable anchor)
// recorded `@i-harness/preset#mountPreset` as a REAL finding that the scanner
// could not emit, because its sole production mention was a COMMENT at
// `packages/tui/src/views/light-personas.ts:2`. That file was deleted with the
// TUI (M65), so as of the 2026-09-24 measurement the row has been in the row set
// on BOTH sides of this fix -- the old collision is history, not the fixture.
// What the fix did move here, measured 2026-09-24: 432 rows to 456, 24 rows
// appearing, every one of them a name whose only production mentions outside its
// declaring module were comments (by the reader's construction it can only be
// that or the entry's own re-export statement; each of the 24 was checked
// against the tree by hand and the list is in the M79 record). Two further
// mentions of the same bug class fired during M77 and M78 (`retryErrorCode`,
// `derivePruneSubstitutes`) and were dodged by REWORDING the comment -- which is
// why the hazard class, not the comments, is what this fix removed.
//
// The lesson the case still carries: the gate's silence about a name was never
// proof that the name is reachable, and after this fix it still is not -- a name
// mentioned in a STRING, or used only inside its own declaring module, retires
// its row by design.
SELF_TEST_CASES.push({
  name: "class 1: a COMMENT naming a type no longer suppresses the row (M79 fixed the documented false negative)",
  expect: ["@i-harness/beta#BetaThing"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/beta#"))
  },
})

SELF_TEST_CASES.push({
  name: "class 1: a COMMENT in an entry file no longer retires that entry's own row",
  expect: ["@i-harness/zeta#EntryCommentOnly"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/zeta#"))
  },
})

SELF_TEST_CASES.push({
  name: "class 1: a name only inside a STRING literal still retires the row (strings are not stripped)",
  expect: ["@i-harness/psi#RealOrphan"],
  run(root) {
    return scanUnusedExports(indexTree(root))
      .map((f) => f.subject)
      .filter((s) => s.startsWith("@i-harness/psi#"))
  },
})

/** The three conventions the digest depends on, each pinned by a published
 *  counterfactual in the baseline document section 2.1: sort order, LF joining,
 *  and a trailing newline on EVERY line. The row set is synthetic so the case
 *  does not rot when the repo's own rows move. */
const SELF_TEST_PUBLISHED_FINDINGS = [
  { kind: "unused-export", subject: "@i-harness/b#Two", evidence: "packages/b/src/index.ts" },
  { kind: "unused-export", subject: "@i-harness/a#One", evidence: "packages/a/src/index.ts" },
  // The THIRD row is what makes the SORT convention visible, and it is the only
  // reason it is here. The two rows above order identically byte-wise and under
  // `localeCompare`, so a `.sort()` -> `.sort((a, b) => a.localeCompare(b))`
  // mutation of `rowsDigest` survived every case (measured: 25/25, exit 0, at
  // M2's HEAD ba656320 -- while that mutant's digest over THIS repository's 523
  // rows is 13e9469f662f5737c37532d1e71d6b06fc2f134bb86784a3c267878aeaa6a5b6, not
  // the published 5acf81aa…). This
  // row's evidence path capitalises `packages/A/`, and `A` (0x41) sorts before
  // `a` (0x61) byte-wise while ICU collation puts the lowercase subject first:
  // the two conventions give different digests for this fixture and the same
  // digest for the two-row one.
  { kind: "unused-export", subject: "@i-harness/A#Upper", evidence: "packages/A/src/index.ts" },
]

// The expectation is the LITERAL hex for this fixture, derived with `node -e`
// and `node:crypto` on 2026-09-16 -- independently of `findingsDigest`. Writing
// `expect: [findingsDigest(SELF_TEST_PUBLISHED_FINDINGS)]` instead would evaluate
// the function under test on BOTH sides, so the case could not fail on a wrong
// digest; and because `expect` is evaluated at module scope, the missing
// function would throw OUTSIDE the harness's per-case `try` -- measured: an
// uncaught ReferenceError at this line, no `FAIL <name>` and no `self-test: N/M`
// line at all, which is why the red state is written this way.
//
// Counterfactuals for this fixture, measured the same way on 2026-09-16: the
// byte-wise sort gives a2064cbc3cba49342cce8ac2899f11b7a876f3960aef644c943b42e3e97e875c
// and `localeCompare` gives
// 0df72bbc55c09f33ab5d0ca17dba31fcd3a2cda62a2c4d2cada7488d2451ceb1, so the sort
// convention is pinned here too; dropping the trailing newline gives
// a41d1798c5c57206e29cfca374bf86e30cb0e498b8631ffb09a66b572922aed2 and joining
// with CRLF gives
// 4b3f098b71cc4bd40de8113259b39a49c74723b0891668b1507028e07fa01679, so those two
// conventions are pinned as well.
SELF_TEST_CASES.push({
  name: "digest: the published row-set digest is reproduced from the findings",
  expect: ["a2064cbc3cba49342cce8ac2899f11b7a876f3960aef644c943b42e3e97e875c"],
  run() {
    return [findingsDigest(SELF_TEST_PUBLISHED_FINDINGS)]
  },
})

// ------------------------------------------------------------ gate self-tests
// A row the baseline does not have is the ONLY failure. The baseline below holds
// every current row but one, so `added` must be exactly that row: this pins both
// directions at once -- a new row IS reported, and the baseline's own rows are
// NOT (returning `current` wholesale, or the whole row set, fails it).
SELF_TEST_CASES.push({
  name: "gate: a row the baseline does not have is the ONLY failure",
  expect: ["unused-export\t@i-harness/alpha#Orphan\tpackages/alpha/src/index.ts"],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const present = current[0]
    // Baseline holds every row BUT one: the reported failure must be exactly
    // the missing one, and a removed row must never be reported as a failure.
    const baseline = { rows: current.filter((k) => k !== present) }
    const { added } = gateDiff(current, baseline, { entries: [] })
    return added
  },
})

// The ratchet half: a baseline row that is GONE is progress. Mutating `added` to
// include `removed` -- the "gate on the count, not on new rows" defect, which
// reddens exactly when someone does the work -- fails this case and only this one.
SELF_TEST_CASES.push({
  name: "gate: an identical row set passes, and a removed row is not a failure",
  expect: [],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const baseline = { rows: [...current, "unused-export\t@i-harness/alpha#SinceRemoved\tpackages/alpha/src/index.ts"] }
    const { added } = gateDiff(current, baseline, { entries: [] })
    return added
  },
})

// The allowlist is keyed on `kind<TAB>subject` alone, so allowlisting a row
// exempts it wherever the row is found -- evidence is what moves under
// refactoring, so an entry carrying it would silently stop exempting. This case
// is what pins that ruling: comparing the allowlist keys against the FULL row
// keys (`allowed.has(k)`, the obvious implementation) matches no entry at all,
// leaving the allowlist inert, and that is the mutation this case fails on.
SELF_TEST_CASES.push({
  name: "gate: a row the ALLOWLIST names never fails, even when it is new",
  expect: [],
  run(root) {
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const first = current[0]
    const allowlist = { entries: [{ key: first.split("\t").slice(0, 2).join("\t"), reason: "test", dated: "2026-09-15" }] }
    const { added } = gateDiff(current, { rows: current.filter((k) => k !== first) }, allowlist)
    return added
  },
})

// The allowlist is only legitimate with BOTH a date and a reason: the roadmap's
// completion definition (backend-polish-roadmap-design.md:125, "基線與 allowlist
// 都帶日期與理由") requires it, and an undated exemption is indistinguishable from
// one nobody remembers granting. Mutation this case fails on: deleting the
// `staleAllowlistEntries` filter -- making it accept any entry, e.g. `return []`
// or `filter(() => false)` -- which would silently admit an exemption no one
// remembers granting, and the gate would pass on it.
SELF_TEST_CASES.push({
  name: "gate: an allowlist entry with no date or reason is reported, not accepted",
  expect: ["unpushed-capability\tguardian"],
  run() {
    const allowlist = { entries: [{ key: "unpushed-capability\tguardian" }] }
    return staleAllowlistEntries(allowlist)
  },
})

// The milestone's completion definition, made re-runnable
// (backend-polish-roadmap-design.md:125 -- "對**故意新增**的一個孤兒會**失敗**").
// Step 1 of M2 Task 4 performed it once, by hand, on the REAL tree: appending
// `export const M2_GATE_PROOF = "delete me"` to
// `packages/guard-repeat-tool/src/index.ts` moved the digest from `5acf81aa…` to
// `be1178de…`, took the table from 523 to 524 rows, and made `--gate` print
// `new  unused-export\t@i-harness/guard-repeat-tool#M2_GATE_PROOF\t…` and exit 1.
// This case performs the same operation on the fixture, so the proof does not
// depend on a human repeating that edit and remembering to revert it.
//
// Honest accounting of its overlap: its expectation coincides with the sibling
// case above ("a row the baseline does not have is the ONLY failure") because
// both pin `gateDiff`'s added-row direction. What differs is the PROCEDURE it
// encodes -- a baseline seeded from the tree as it stood BEFORE the orphan
// existed, which is what "someone added an export nobody calls" looks like to
// the gate, rather than a baseline built by removing `current[0]`.
SELF_TEST_CASES.push({
  name: "gate: a deliberately added orphan fails the gate (the milestone's completion proof)",
  expect: ["unused-export\t@i-harness/alpha#Orphan\tpackages/alpha/src/index.ts"],
  run(root) {
    // The fixture tree already contains the orphan class 1 reports; seeding a
    // baseline from the fixture WITHOUT it is what a real "someone added an
    // export nobody calls" looks like to the gate.
    const current = scanUnusedExports(indexTree(root)).map(rowKey)
    const withoutOrphan = current.filter((k) => !k.includes("#Orphan"))
    return gateDiff(current, { rows: withoutOrphan }, { entries: [] }).added
  },
})

// ------------------------------------------------------ CLI wiring self-tests
// Every case above tests a FUNCTION. Until these, nothing tested the CALL SITE:
// measured on the committed blob at `ba656320`, deleting the whole `--gate`
// block, the whole `--digest` block, the allowlist read inside `--gate`, or the
// stale-disposition check each left `--self-test` at a full pass, because no case
// ever called `main()` -- the harness only ever called a scanner. These cases
// drive `main(argv)` over the fixture with real data files in TEMP and assert on
// BOTH its exit code and what it printed, so the call sites are pinned by the
// same suite that pins the rules.

/** The digest rule, implemented a SECOND time so that these cases' expectations
 *  are not derived from the function under test: sha256 over the row keys sorted
 *  byte-wise, LF-joined, every line newline-terminated -- the convention the
 *  baseline document section 2.1 publishes as counterfactuals. */
function independentRowsDigest(rows) {
  return createHash("sha256").update(rows.slice().sort().map((l) => `${l}\n`).join(""), "utf8").digest("hex")
}

/** `main(argv)` with stdout and stderr captured, so a case can assert on what the
 *  CLI SAID as well as what it returned. The streams are restored in a
 *  `finally`, so a throwing case cannot leave the harness mute. */
function captureMain(argv) {
  const out = []
  const err = []
  const log = console.log
  const error = console.error
  console.log = (...a) => out.push(a.join(" "))
  console.error = (...a) => err.push(a.join(" "))
  try {
    return { code: main(argv), out, err }
  } finally {
    console.log = log
    console.error = error
  }
}

/** Every row the five scanners emit over the fixture, as canonical sorted keys --
 *  the same scanners and the same `rowKey` `main` uses, so a baseline built from
 *  these holds exactly the fixture's live row set. */
function fixtureRowKeys(root) {
  return SCANNERS.flatMap((s) => s(indexTree(root))).map(rowKey).slice().sort()
}

/** Write a JSON data file into the case's fixture dir and return its path. */
function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

/** A self-consistent baseline for `rows`, written into the case's fixture dir.
 *  `count` and `digest` are computed by the SECOND implementation above, so a
 *  case that feeds this to `--gate` also pins the digest convention. */
function writeFixtureBaseline(root, rows, name) {
  return writeJsonFile(join(root, `${name}-baseline.json`), {
    seededAt: "2026-09-16",
    reason: "a self-test fixture baseline, written by the case that needs it",
    count: rows.length,
    digest: independentRowsDigest(rows),
    rows,
  })
}

/** Drive the real `--gate` over the fixture with the given baseline rows and
 *  allowlist, and hand back its exit code plus everything it printed. */
function gateCli(root, rows, allowlist, name) {
  return captureMain([
    "--gate", "--root", root,
    "--baseline", writeFixtureBaseline(root, rows, name),
    "--allowlist", writeJsonFile(join(root, `${name}-allowlist.json`), allowlist),
  ])
}

// `count` and `digest` are what the gate's own summary line PUBLISHES, so they
// are the baseline's identity; before this check a file whose `rows` were the
// live set but whose count/digest were invented printed `with 999 (digest
// deadbeef)` and returned 0. A wrong SHAPE is the same class one step further:
// `{}`, `{"rows":[]}` and `{"rows":"abc"}` all came back through exit 1, the code
// reserved for "new rows". Mutation that reddens this case: deleting the
// `baselineProblems` call from `--gate`, which turns the five refusals into
// 0 / 0 / 1 / 1 / 1 / 0.
SELF_TEST_CASES.push({
  name: "cli: a baseline whose count/digest do not describe its own rows is refused",
  expect: ["consistent=0", "count=2", "deadbeef=2", "emptyRows=2", "noDigest=2", "notAnObject=2", "stringRows=2"],
  run(root) {
    const rows = fixtureRowKeys(root)
    const al = writeJsonFile(join(root, "shape-allowlist.json"), { entries: [] })
    const gate = (label, baseline) => {
      const p = writeJsonFile(join(root, `shape-${label}.json`), baseline)
      return `${label}=${captureMain(["--gate", "--root", root, "--baseline", p, "--allowlist", al]).code}`
    }
    return [
      gate("count", { rows, count: 999, digest: independentRowsDigest(rows) }),
      gate("deadbeef", { rows, count: rows.length, digest: "deadbeef" }),
      gate("notAnObject", {}),
      gate("emptyRows", { rows: [] }),
      gate("stringRows", { rows: "abc" }),
      gate("noDigest", { rows, count: rows.length }),
      gate("consistent", { rows, count: rows.length, digest: independentRowsDigest(rows) }),
    ]
  },
})

// A write that cannot land used to escape as an 18-line ENOENT stack trace and
// exit 1 -- the code a shell pipeline reads as "1 = new rows", which is exactly
// the false read this gate exists to prevent. Mutation that reddens this case:
// removing the `try`/`catch` around `writeFileSync`.
SELF_TEST_CASES.push({
  name: "cli: a seed whose baseline cannot be written is a usage error, not a stack trace",
  expect: ["code=2", "stderrLines=1"],
  run(root) {
    const r = captureMain(["--seed-baseline", "--root", root, "--baseline", join(root, "no-such-dir", "baseline.json")])
    return [`code=${r.code}`, `stderrLines=${r.err.length}`]
  },
})

// `--seed-baseline --gate` used to seed, print two seed lines and exit 0 without
// ever gating: a parsed-but-ignored flag combination, the very defect the
// allowlist files against `tui --yes`. Mutation that reddens this case: deleting
// the refusal, which then seeds the target and returns 0.
SELF_TEST_CASES.push({
  name: "cli: --seed-baseline --gate is refused rather than silently seeding",
  expect: ["code=2", "target=absent"],
  run(root) {
    const target = join(root, "combined-seed.json")
    const r = captureMain(["--seed-baseline", "--gate", "--root", root, "--baseline", target])
    return [`code=${r.code}`, `target=${existsSync(target) ? "written" : "absent"}`]
  },
})

// The seed guard's RULE, stated once so every direction is pinned: a seed is
// refused only when the tree being scanned is not this repository AND the path it
// would write IS this repository's committed baseline. Raw-string comparison
// refused valid spellings of this tree (`d:\i-harness-main`, a trailing
// separator, `\\?\D:\...`, a junction) and still let `--root <foreign>
// --baseline <the named baseline>` replace the committed 523-row file with a
// foreign tree's rows and exit 0. Every alias below is spelled so that it differs
// from the canonical string but resolves to it -- `join(ROOT, "..")` is NOT one,
// because `path.join` normalises it away. Mutation that reddens this case:
// comparing `root !== ROOT` and `baselinePath === BASELINE_DEFAULT` as raw
// strings, which makes the three alias readings `yes`.
SELF_TEST_CASES.push({
  name: "seed guard: only a foreign tree writing THIS repository's baseline is refused",
  expect: ["baselineAlias=yes", "foreignNamed=no", "foreignRepo=yes", "rootCaseAlias=no", "rootSlashAlias=no", "sameRepo=no"],
  run(root) {
    const named = join(ROOT, "scripts", "audit", "reachability-baseline.json")
    const slash = named.split("\\").join("/")
    const bare = ROOT + "/"
    const lowerDrive = ROOT[0].toLowerCase() + ROOT.slice(1)
    const yes = (v) => (v ? "yes" : "no")
    return [
      `sameRepo=${yes(seedWouldClobberRepoBaseline(ROOT, BASELINE_DEFAULT))}`,
      `rootSlashAlias=${yes(seedWouldClobberRepoBaseline(bare, named))}`,
      `rootCaseAlias=${yes(seedWouldClobberRepoBaseline(lowerDrive, named))}`,
      `baselineAlias=${yes(seedWouldClobberRepoBaseline(root, slash))}`,
      `foreignRepo=${yes(seedWouldClobberRepoBaseline(root, BASELINE_DEFAULT))}`,
      `foreignNamed=${yes(seedWouldClobberRepoBaseline(root, join(root, "named.json")))}`,
    ]
  },
})

// The same rule through the real CLI, both directions. The committed baseline is
// restored in a `finally`, so that even with the guard removed a self-test run
// leaves the tree exactly as it found it: a test must never be able to damage
// the artifact it protects. Mutation that reddens this case: deleting the
// `seedWouldClobberRepoBaseline` call from `main`, which then writes the fixture
// rows into this repository's baseline and returns 0.
SELF_TEST_CASES.push({
  name: "cli: the seed guard refuses the clobbering shape and still allows a named target",
  expect: ["foreignNamed=allowed", "foreignRepo=refused", "namedFile=written"],
  run(root) {
    const named = join(root, "seed-named.json")
    const allowed = captureMain(["--seed-baseline", "--root", root, "--baseline", named]).code
    const saved = readFileSync(BASELINE_DEFAULT)
    let refused
    try {
      refused = captureMain(["--seed-baseline", "--root", root, "--baseline", BASELINE_DEFAULT]).code
    } finally {
      writeFileSync(BASELINE_DEFAULT, saved)
    }
    return [
      `foreignNamed=${allowed === 0 ? "allowed" : `code ${allowed}`}`,
      `foreignRepo=${refused === 2 ? "refused" : `code ${refused}`}`,
      `namedFile=${existsSync(named) ? "written" : "absent"}`,
    ]
  },
})

// A valid-JSON WRONG-SHAPE allowlist (`{"entries":3}`, `{"entries":[null]}`, a
// top-level `[null]` -- `Array#entries` is a METHOD) used to escape as an
// uncaught TypeError with a stack trace AND exit 1, the code reserved for "new
// rows". Mutation that reddens this case: deleting the `allowlistProblems` call
// from `--gate`, which then reports all four wrong shapes as 0 (the gate reads
// them as an empty allowlist and passes).
//
// The last two cases are the SECOND route to the same silence, measured by
// walking into it on 2026-09-18: an entry can be well-shaped as a JSON OBJECT
// and still be inert, because the two arrays name their target with DIFFERENT
// fields (`entries` uses `key`, `noRow` uses `item`). Appending a `{key, …}`
// entry to `noRow` -- which is what an edit anchored on the wrong `],` does --
// passed every check above and exempted nothing. Same hazard `allowlistKey`'s
// comment names for the key FORMAT ("the allowlist becomes inert and looks
// harmless while exempting nothing"), reached through the shape instead.
SELF_TEST_CASES.push({
  name: "cli: a wrong-shape allowlist is a configuration error, not a scan failure",
  expect: ["entriesArray=2", "entriesNumber=2", "entryNull=2", "topLevelArray=2", "wellShaped=0", "noKey=2", "noItem=2"],
  run(root) {
    const rows = fixtureRowKeys(root)
    const gate = (label, allowlist) => {
      const al = writeJsonFile(join(root, `shape-al-${label}.json`), allowlist)
      const bl = writeFixtureBaseline(root, rows, `shape-al-${label}`)
      return `${label}=${captureMain(["--gate", "--root", root, "--baseline", bl, "--allowlist", al]).code}`
    }
    return [
      gate("entriesNumber", { entries: 3 }),
      gate("entryNull", { entries: [null] }),
      gate("topLevelArray", [null]),
      gate("entriesArray", { entries: { a: 1 } }),
      gate("wellShaped", { entries: [] }),
      // an entries item naming its target the noRow way
      gate("noKey", { entries: [{ item: "unused-export\tx", dated: "2026-09-15", reason: "why" }] }),
      // a noRow item naming its target the entries way -- the exact mistake
      gate("noItem", { noRow: [{ key: "unused-export\tx", dated: "2026-09-15", reason: "why" }] }),
    ]
  },
})

// The allowlist's price, clause by clause. The suite used to pin only the
// CONJUNCTION -- an entry with neither field -- so dropping `!e.dated`, dropping
// `!e.reason` or dropping the `.trim() === ""` test each left every case green
// (measured: 25/25). `noRow` was not priced at all. Mutations that redden this
// case: any one of those three clauses deleted, or `staleNoRowEntries` returning
// `[]`.
SELF_TEST_CASES.push({
  name: "gate: each allowlist price clause is enforced on its own, for entries and noRow",
  expect: ["blank=blank", "both=both", "noDate=nodate", "noReason=noreason", "noRowNoDate=nr", "ok="],
  run() {
    const one = (entry) => staleAllowlistEntries({ entries: [entry] }).join(",")
    const nr = (entry) => staleNoRowEntries({ noRow: [entry] }).join(",")
    return [
      `both=${one({ key: "both" })}`,
      `noDate=${one({ key: "nodate", reason: "why" })}`,
      `noReason=${one({ key: "noreason", dated: "2026-09-15" })}`,
      `blank=${one({ key: "blank", dated: "2026-09-15", reason: "   " })}`,
      `ok=${one({ key: "ok", dated: "2026-09-15", reason: "why" })}`,
      `noRowNoDate=${nr({ item: "nr", reason: "why" })}`,
    ]
  },
})

// The same price through the real CLI for the allowlist's OTHER half: a `noRow`
// disposition without a date gated at exit 0, so the roadmap's "基線與 allowlist
// 都帶日期與理由" was machine-enforced for 24 of the 37 committed keys and taken
// on trust for the other 13. Mutation that reddens this case: deleting the
// `staleNoRowEntries` half of the refusal in `--gate`.
SELF_TEST_CASES.push({
  name: "cli: a noRow disposition without a date is refused like an entries key",
  expect: ["noRowDated=0", "noRowNoDate=2"],
  run(root) {
    const rows = fixtureRowKeys(root)
    const withNoRow = (label, noRow) => `${label}=${gateCli(root, rows, { entries: [], noRow }, label).code}`
    return [
      withNoRow("noRowNoDate", [{ item: "x", reason: "why" }]),
      withNoRow("noRowDated", [{ item: "x", reason: "why", dated: "2026-09-15" }]),
    ]
  },
})

// The wiring the review measured as unpinned in every direction. The baseline
// below holds every fixture row BUT one, so the only new row IS the one the
// allowlist names -- which is what makes the three readings mean three different
// things: the allowlist read is what turns `1` into `0`, and the stale check is
// what turns `0` back into `2` BEFORE the exemption is honoured. Mutations that
// redden this case, each measured separately: deleting the `loadJsonIfPresent`
// call for the allowlist (`allowlisted=1`), deleting the stale check
// (`staleButNamed=0`), or deleting the whole `--gate` block (all three read `0`
// off the human table).
SELF_TEST_CASES.push({
  name: "cli: --gate exempts exactly the row the allowlist names, and refuses a stale entry first",
  expect: ["allowlisted=0", "notAllowlisted=1", "staleButNamed=2"],
  run(root) {
    const rows = fixtureRowKeys(root)
    const first = rows[0]
    const key = allowlistKey(first)
    const baseline = writeFixtureBaseline(root, rows.filter((k) => k !== first), "read")
    const gate = (label, entries) => {
      const al = writeJsonFile(join(root, `read-${label}.json`), { entries })
      return `${label}=${captureMain(["--gate", "--root", root, "--baseline", baseline, "--allowlist", al]).code}`
    }
    return [
      gate("allowlisted", [{ key, dated: "2026-09-15", reason: "a wiring fixture" }]),
      gate("notAllowlisted", []),
      gate("staleButNamed", [{ key, reason: "no date on purpose" }]),
    ]
  },
})

// The `--digest` block, which returned before the JSON branch and which no case
// covered: deleting it left the suite green while `--digest` printed the human
// table instead. The expectation is the SECOND digest implementation's value for
// the fixture rows, so this case also pins the sort/LF/trailing-newline
// convention against the real code path. Mutation that reddens it: deleting the
// `--digest` block.
SELF_TEST_CASES.push({
  name: "cli: --digest prints the row-set digest of the tree it scanned",
  expect: ["code=0", "digest=match"],
  run(root) {
    const want = independentRowsDigest(fixtureRowKeys(root))
    const r = captureMain(["--digest", "--root", root])
    return [`code=${r.code}`, `digest=${r.out.join("\n").trim() === want ? "match" : "mismatch"}`]
  },
})

// An inert entry is the silent-exemption failure mode from the other direction:
// it looks like a decision and exempts nothing. It is reported and never failed,
// because the roadmap forbids failing on a low count -- an allowlisted row that
// was legitimately fixed leaves exactly this trace, and reddening there is the
// "gate gets switched off" defect. Mutation that reddens this case: deleting the
// inert warning, which makes `inert=quiet`.
SELF_TEST_CASES.push({
  name: "cli: an allowlist entry that matches no live row is warned about, never failed",
  expect: ["clean=quiet", "code=0", "inert=warned"],
  run(root) {
    const rows = fixtureRowKeys(root)
    const live = { key: allowlistKey(rows[0]), dated: "2026-09-15", reason: "a live row" }
    const dead = { key: "unused-export\t@i-harness/ghost#Never", dated: "2026-09-15", reason: "an inert row" }
    const warns = (r) => (r.err.some((l) => l.includes("inert")) ? "warned" : "quiet")
    const withInert = gateCli(root, rows, { entries: [live, dead] }, "inert")
    const clean = gateCli(root, rows, { entries: [live] }, "inert-clean")
    return [`code=${withInert.code}`, `inert=${warns(withInert)}`, `clean=${warns(clean)}`]
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

// The `--self-test` dispatch is at the END of this file, not here: it must run
// after the consts a `main()`-driving case reaches. See the note there.

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

// ------------------------------------------------------- row identity + digest
/** The canonical identity of a finding. The digest, the baseline and the gate
 *  all key on this exact string, so it is defined once, here. */
function rowKey(f) {
  return `${f.kind}\t${f.subject}\t${f.evidence}`
}

/** sha256 over row KEYS rendered as sorted lines, LF-joined, with EVERY line
 *  newline-terminated. All three conventions are load-bearing and are published
 *  as counterfactuals in docs/audit/2026-09-15-reachability-baseline.md section
 *  2.1: dropping the trailing newline and sorting by locale both produce
 *  different digests, which is why the rule is stated rather than assumed.
 *  `Array#sort()` with no comparator is the byte-wise (code-unit) sort that rule
 *  names -- NOT a locale-aware collation. It is defined over row keys rather
 *  than findings so that the baseline's own `rows` can be checked with the same
 *  rule the tool publishes (see `baselineProblems`). */
function rowsDigest(rows) {
  const text = rows.slice().sort().map((l) => `${l}\n`).join("")
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The digest of a scan: `rowsDigest` over the findings' canonical keys. */
function findingsDigest(findings) {
  return rowsDigest(findings.map(rowKey))
}

// ------------------------------------------------------------ baseline + gate
const BASELINE_DEFAULT = join(ROOT, "scripts/audit/reachability-baseline.json")
const ALLOWLIST_DEFAULT = join(ROOT, "scripts/audit/reachability-allowlist.json")

/** A missing optional data file is not an error here: `--allowlist` is legal to
 *  omit, and `--gate` reports the missing BASELINE itself rather than crashing
 *  with a stack trace a caller could mistake for a scan failure. */
function loadJsonIfPresent(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`reachability: ${path} is not valid JSON: ${err.message}`)
  }
}

/** A baseline is only the identity it PUBLISHES when its own `count` and
 *  `digest` describe its own `rows`. Before this check the gate printed
 *  `with 999 (digest deadbeef)` beside the live row set and exited 0, so the two
 *  values the plan calls the baseline's identity were attestations nobody had
 *  verified -- and a wrong-SHAPE baseline (`{}`, `{"rows":[]}`,
 *  `{"rows":"abc"}`) was reported through exit 1, the code reserved for "new
 *  rows", so a caller went looking for an orphan that did not exist.
 *  Returns [] when the file is self-consistent. */
function baselineProblems(baseline) {
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline))
    return [`the file is not a JSON object (it is ${Array.isArray(baseline) ? "an array" : typeof baseline})`]
  if (!Array.isArray(baseline.rows))
    return [`"rows" is ${baseline.rows === undefined ? "missing" : typeof baseline.rows}, not an array`]
  const problems = []
  const recomputed = rowsDigest(baseline.rows)
  if (baseline.count !== baseline.rows.length)
    problems.push(`"count" is ${JSON.stringify(baseline.count)}, but the file holds ${baseline.rows.length} row(s)`)
  if (baseline.digest !== recomputed)
    problems.push(`"digest" is ${JSON.stringify(baseline.digest)}, but its own rows hash to ${recomputed}`)
  return problems
}

/** The parsed disposition lists of an allowlist, each guaranteed to be an
 *  array. A valid-JSON WRONG SHAPE used to reach `.filter`/`.map` and escape as
 *  an uncaught TypeError with a stack trace AND exit 1 -- the code the caller
 *  reads as "new rows". A top-level array is wrong shape too: `Array#entries` is
 *  a METHOD, so the obvious `allowlist.entries` lookup on `[null]` finds a
 *  function. */
function arrayOrEmpty(v) {
  return Array.isArray(v) ? v : []
}

/** Structural problems with an allowlist, as messages. A malformed allowlist is
 *  a CONFIGURATION error (exit 2), never a scan result; the date/reason price is
 *  `staleDisposition`'s job, one level down. Returns [] when the shape is usable,
 *  so an empty or absent allowlist stays legal. */
function allowlistProblems(allowlist) {
  if (allowlist === null || typeof allowlist !== "object" || Array.isArray(allowlist))
    return [`the file is not a JSON object (it is ${Array.isArray(allowlist) ? "an array" : typeof allowlist})`]
  const problems = []
  for (const field of ["entries", "noRow"]) {
    const v = allowlist[field]
    if (v === undefined) continue
    if (!Array.isArray(v)) {
      problems.push(`"${field}" is ${typeof v}, not an array`)
      continue
    }
    v.forEach((e, i) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        problems.push(`"${field}[${i}]" is ${e === null ? "null" : Array.isArray(e) ? "an array" : typeof e}, not an object`)
        return
      }
      // The field THIS array uses to name its target. An entry can be a
      // well-formed object and still be inert: `gateDiff` builds its allowed-set
      // from `entries[*].key`, and `staleNoRowEntries` reads `noRow[*].item`, so
      // a missing -- or wrong-array -- naming field contributes `undefined` and
      // matches nothing. That is the hazard `allowlistKey`'s comment already
      // names for the key FORMAT ("the allowlist becomes inert and looks harmless
      // while exempting nothing"), reached by a second route. Measured
      // 2026-09-18 by making the mistake: a `{key, …}` object appended to `noRow`
      // -- which is what an edit anchored on the wrong `],` produces -- passed
      // every check that existed and exempted nothing.
      const naming = field === "entries" ? "key" : "item"
      const named = e[naming]
      if (typeof named !== "string" || named.trim() === "") {
        problems.push(`"${field}[${i}]" has no usable "${naming}" for this array (got ${JSON.stringify(named)})`)
      }
    })
  }
  return problems
}

/** Rows that must fail the gate: present now, in neither the baseline nor the
 *  allowlist. Rows that DISAPPEARED are progress and never fail -- the roadmap
 *  is explicit that the gate fails on new orphans, never on a low count, and a
 *  gate that reddens when work is done gets switched off within a week. */
function gateDiff(current, baseline, allowlist) {
  const known = new Set(baseline?.rows ?? [])
  const allowed = new Set(arrayOrEmpty(allowlist?.entries).map((e) => e && e.key))
  const added = current.filter((k) => !known.has(k) && !allowed.has(allowlistKey(k)))
  const removed = [...known].filter((k) => !current.includes(k))
  return { added: added.slice().sort(), removed: removed.slice().sort() }
}

/** The allowlist's key for a row, which is `kind<TAB>subject` -- deliberately
 *  NOT the full row key the baseline and digest use. Evidence is the part that
 *  moves when a file is refactored, so an entry keyed on all three fields
 *  silently stops exempting the moment a path shifts, which is worse than no
 *  entry. Comparing a `kind<TAB>subject` entry against a full row key (the
 *  obvious `allowed.has(k)`) therefore never matches ANY entry: the allowlist
 *  becomes inert and looks harmless while exempting nothing. */
function allowlistKey(k) {
  return k.split("\t").slice(0, 2).join("\t")
}

/** An exemption's price, and the whole of it: BOTH a date and a reason, with a
 *  reason that is not blank. The roadmap's completion definition requires it
 *  ("基線與 allowlist 都帶日期與理由"), and an undated exemption is
 *  indistinguishable from one nobody remembers granting. Every clause is
 *  enforced on its own -- an earlier suite pinned only their conjunction, so
 *  dropping any single one of the three left the self-test green. */
function isStaleDisposition(e) {
  return !e || !e.dated || !e.reason || String(e.reason).trim() === ""
}

/** The `entries` keys that fail that test, so `--gate` can print them and the
 *  self-test can pin it. */
function staleAllowlistEntries(allowlist) {
  return arrayOrEmpty(allowlist?.entries)
    .filter(isStaleDisposition)
    .map((e) => e && e.key)
    .sort()
}

/** The same price for the allowlist's OTHER half. The roadmap says "基線與
 *  allowlist", not "the entries of the allowlist": a `noRow` disposition is a
 *  decision about a row the scanner does not emit, and 13 of the 37 committed
 *  keys are documentation-only. Before this check the rule was machine-enforced
 *  for 24 dispositions and taken on trust for the other 13. */
function staleNoRowEntries(allowlist) {
  return arrayOrEmpty(allowlist?.noRow)
    .filter(isStaleDisposition)
    .map((e) => e && e.item)
    .sort()
}

/** `entries` keys that match no live row. An inert entry exempts nothing while
 *  looking like a decision -- the silent-exemption failure mode from the other
 *  direction, reached by renaming a subject or by fixing the row by accident.
 *  Reported as a WARNING and never as a failure: the roadmap fails on new rows
 *  only, and failing an entry whose row was legitimately fixed is exactly the
 *  "gate reddens when work is done" defect. */
function inertAllowlistEntries(allowlist, current) {
  const live = new Set(current.map(allowlistKey))
  return arrayOrEmpty(allowlist?.entries)
    .filter((e) => !live.has(e && e.key))
    .map((e) => e && e.key)
    .sort()
}

/** The baseline's own `reason`, written BY THE TOOL so the data file carries a
 *  reason as well as a date (roadmap :125, "基線與 allowlist 都帶日期與理由").
 *  It is a reason for the file's EXISTENCE, not a restatement of its field
 *  names, and it rides in the `--seed-baseline` payload so the committed file is
 *  never hand-edited: a hand-added key would break the rule that the tool is the
 *  only writer. */
const BASELINE_REASON =
  "The accepted orphan population of this repository at seededAt. Every row here was reported by the scanner when this file was seeded, and this is the set the gate treats as known: it fails only on rows OUTSIDE it (a row a later change adds) and never on rows that leave it (reported as progress), so the file is a ratchet and not a cleanup target. It is not a claim that a row here is dead. The adjudications behind the allowlist, and the reasons for the rows that stay, are in docs/audit/2026-09-15-reachability-baseline.md section 6 and in the dated scripts/audit/reachability-allowlist.json. Regenerate with --seed-baseline; never edit by hand."

// ------------------------------------------------------- the classes' strength
// Per-class tally. The status strings are not decoration: class 1 is an
// UNCONSUMED EXPORT EDGE (the symbol may still be reachable through a path the
// scanner cannot follow), 3 and 4 are LOWER BOUNDS (they depend on what the
// walker saw), and 5 is READER-DEPENDENT (a setting may be read by a consumer
// outside this tree). Printing a bare number next to them would overstate all
// four; M1's reviews removed exactly that overstatement from its documents.
// The map covers all five kinds the tool emits today; a kind it lacks prints an
// explicit "(no status recorded)" rather than a bare count, because silence
// reads as a status.
const CLASS_STATUS = {
  "unused-export": "unconsumed export edge, not dead code",
  "producerless-event": "anchor is a file-name pattern; a lower bound",
  "unread-flag": "lower bound (depends on the walker's parse)",
  "unpushed-capability": "lower bound (depends on the walker's parse)",
  "unconsulted-setting": "reader-dependent (consumers outside this tree are invisible)",
}

// ----------------------------------------------------------------------- main
/** `statSync` that answers instead of throwing, so a missing path and a path
 *  that is not a directory are both simply "not a directory". */
function isDirectorySync(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** One identity for a path, so two spellings of one directory compare equal.
 *  `realpathSync.native` collapses case, separator style, `.`/`..` segments and
 *  junctions/symlinks; on a path that does not exist yet (a seed target usually
 *  does not) it throws, and `resolve` is the best available answer. Comparing
 *  raw strings instead refused `d:\i-harness-main`, `\\?\D:\I-harness-main` and
 *  a junction-reached script, all of which ARE this tree. */
function canonicalPath(p) {
  try { return realpathSync.native(p) } catch { return resolve(p) }
}

/** Whether a seed would overwrite THIS repository's committed baseline from a
 *  DIFFERENT tree. The one rule that closes both halves of the hole: refusing
 *  only "no explicit `--baseline`" still let `--root <foreign> --baseline <the
 *  named baseline>` replace the committed 523-row file with a foreign tree's
 *  rows and exit 0. A named target that is not this repository's baseline stays
 *  legal -- seeding another tree's baseline from that tree is what `--root` is
 *  for -- and so does re-seeding THIS tree. */
function seedWouldClobberRepoBaseline(root, baselinePath) {
  return canonicalPath(root) !== canonicalPath(ROOT) && canonicalPath(baselinePath) === canonicalPath(BASELINE_DEFAULT)
}

/** A root the scanner cannot walk is a USAGE error, never a clean tree. Before
 *  this guard, `--root ./nope` printed `0 ts files, 0 finding(s)` and exited 0,
 *  and `--root package.json` printed the same thing because the `readdirSync`
 *  in `collectTs` threw straight into its own catch: an under-report no caller
 *  can tell from a clean sweep, which is the exact failure this tool exists to
 *  prevent. `existsSync` was imported for this and never called. Exit 2, and the
 *  message goes to stderr, so a caller cannot read it as a result.
 *
 *  `cliArgs` defaults to this process's argv; a self-test case passes its own so
 *  the CLI can be driven from inside the suite. Every read of the command line
 *  below goes through `has`/`val`, which is what makes that possible. */
function main(cliArgs = args) {
  const has = (flag) => cliArgs.includes(flag)
  const val = (name, dflt) => {
    const i = cliArgs.indexOf(name)
    return i >= 0 && cliArgs[i + 1] ? cliArgs[i + 1] : dflt
  }
  // A combination that seeds AND gates would always pass: the seed rewrites the
  // very file the gate reads, so the gate would compare the tree against itself.
  // The allowlist files `tui --yes` as "parsed but never read", and a flag that
  // is accepted and then ignored is that same defect, so this is refused rather
  // than resolved by precedence.
  if (has("--seed-baseline") && has("--gate")) {
    console.error("reachability: --seed-baseline and --gate cannot be combined -- seeding rewrites the baseline the gate reads, so the gate would compare the tree against itself; run one or the other")
    return 2
  }
  const root = resolve(val("--root", ROOT))
  if (!existsSync(root)) {
    console.error(`reachability: --root ${root} does not exist`)
    return 2
  }
  if (!isDirectorySync(root)) {
    console.error(`reachability: --root ${root} is not a directory`)
    return 2
  }
  const files = indexTree(root)
  // The same refusal for a real directory that holds no TypeScript at all: an
  // empty scan reports zero findings for the same reason a broken rule does.
  if (files.length === 0) {
    console.error(`reachability: --root ${root} contains no .ts/.tsx files -- refusing to report a clean sweep`)
    return 2
  }
  const findings = SCANNERS.flatMap((s) => s(files))

  const baselinePath = resolve(val("--baseline", BASELINE_DEFAULT))
  const allowlistPath = resolve(val("--allowlist", ALLOWLIST_DEFAULT))
  const current = findings.map(rowKey)

  if (has("--seed-baseline")) {
    // Seeding writes the file the SCAN's tree owns, and `BASELINE_DEFAULT` is
    // this script's own root -- so a seed of another tree into it silently
    // replaced the committed row set with that tree's rows and exited 0 (measured
    // both without an explicit `--baseline` and with the committed path named
    // explicitly). One canonical-path rule refuses every spelling of that shape
    // while still allowing `--root .` and a named target.
    if (seedWouldClobberRepoBaseline(root, baselinePath)) {
      console.error(`reachability: --seed-baseline would write this repository's baseline (${baselinePath}) from --root ${root} -- pass --baseline <path> to seed another tree`)
      return 2
    }
    const payload = {
      seededAt: new Date().toISOString().slice(0, 10),
      reason: BASELINE_REASON,
      digest: findingsDigest(findings),
      count: current.length,
      rows: current.slice().sort(),
    }
    // A write that cannot land is a usage error (2), not a crash: unwrapped, an
    // ENOENT escaped as an 18-line stack trace and exit 1, which a shell
    // pipeline reads as "1 = new rows" -- the exact false read this gate exists
    // to prevent.
    try {
      writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
    } catch (err) {
      console.error(`reachability: could not write the baseline to ${baselinePath}: ${err.message}`)
      return 2
    }
    console.log(`reachability: seeded ${payload.count} row(s) into ${baselinePath}`)
    console.log(`reachability: digest ${payload.digest}`)
    return 0
  }

  if (has("--gate")) {
    let baseline
    try {
      baseline = loadJsonIfPresent(baselinePath)
    } catch (err) {
      console.error(err.message)
      return 2
    }
    if (baseline === undefined) {
      console.error(`reachability: no baseline at ${baselinePath} -- seed one with --seed-baseline`)
      return 2
    }
    // The baseline's own `count` and `digest` are what the summary line below
    // PUBLISHES, and a wrong shape is a configuration error rather than a scan
    // result. Both are checked before any comparison: otherwise a baseline whose
    // `rows` are the live set and whose count/digest are invented printed
    // `with 999 (digest deadbeef)` and passed, and `{"rows":"abc"}` was reported
    // through exit 1, the code reserved for new rows.
    const baselineProblem = baselineProblems(baseline)
    if (baselineProblem.length > 0) {
      console.error(`reachability: the baseline at ${baselinePath} is not usable -- refusing to gate on it:`)
      for (const p of baselineProblem) console.error(`  ${p}`)
      return 2
    }
    let allowlist
    try {
      allowlist = loadJsonIfPresent(allowlistPath)
    } catch (err) {
      // A malformed allowlist must NOT reach the caller as exit 1: that code
      // means "new rows". Escaping as an uncaught throw printed a stack trace
      // AND exited 1, which a caller reads as a failed scan.
      console.error(err.message)
      return 2
    }
    const allowlistProblem = allowlistProblems(allowlist)
    if (allowlistProblem.length > 0) {
      console.error(`reachability: the allowlist at ${allowlistPath} is malformed -- refusing to gate on it:`)
      for (const p of allowlistProblem) console.error(`  ${p}`)
      return 2
    }
    // A dated, reasoned disposition is the price of an exemption, and this check
    // runs BEFORE `gateDiff` exempts anything: an entry missing either field is
    // refused rather than honoured, because a stale exemption that keeps
    // exempting is exactly the silent, unremembered exception the allowlist
    // exists to prevent. Exit 2 matches the malformed-allowlist refusal above --
    // this is a configuration error, never the "new rows" result the caller
    // reads from exit 1. The same price is charged to `noRow`, the allowlist's
    // other half: the roadmap says "基線與 allowlist", not "the entries of the
    // allowlist".
    const stale = staleAllowlistEntries(allowlist)
    const staleNoRow = staleNoRowEntries(allowlist)
    if (stale.length + staleNoRow.length > 0) {
      console.error(`reachability: ${stale.length + staleNoRow.length} allowlist disposition(s) without a date or reason -- refusing to gate on them:`)
      for (const k of stale) console.error(`  stale ${k}`)
      for (const k of staleNoRow) console.error(`  stale noRow ${k}`)
      return 2
    }
    // An entry that matches no live row exempts nothing while reading as a
    // decision. That is the silent-exemption failure mode from the other
    // direction, so it is said out loud -- but only said: the roadmap fails on
    // new rows and never on a low count, and an allowlisted row that was
    // legitimately fixed leaves exactly this trace.
    const inert = inertAllowlistEntries(allowlist, current)
    if (inert.length > 0) {
      console.error(`reachability: warning: ${inert.length} allowlist entr(ies) match no live row -- they exempt nothing:`)
      for (const k of inert) console.error(`  inert ${k}`)
    }
    const { added, removed } = gateDiff(current, baseline, allowlist)
    console.log(`reachability: ${current.length} row(s) now; baseline seeded ${baseline.seededAt} with ${baseline.count} (digest ${baseline.digest})`)
    if (removed.length > 0) {
      console.log(`reachability: ${removed.length} baseline row(s) no longer present (progress, not a failure):`)
      for (const k of removed) console.log(`  gone ${k}`)
    }
    if (added.length > 0) {
      console.error(`reachability: ${added.length} NEW row(s) -- the gate fails:`)
      for (const k of added) console.error(`  new  ${k}`)
      return 1
    }
    console.log("reachability: gate PASS -- no new rows")
    return 0
  }

  // The digest alone, so a caller can compare identities without parsing rows.
  // It is answered BEFORE the machine-readable branch, so `--digest --json`
  // prints the digest only; the usage block above says so rather than leaving a
  // caller to infer it.
  if (has("--digest")) {
    console.log(findingsDigest(findings))
    return 0
  }

  if (has("--json")) {
    console.log(JSON.stringify({ root, digest: findingsDigest(findings), findings }, null, 2))
  } else {
    console.log(`reachability: ${files.length} ts files, ${findings.length} finding(s)\n`)
    // The tally sits BETWEEN the summary line and the flat list, so a count is
    // never printed without the strength of the evidence behind it. A kind the
    // map does not know is printed explicitly rather than skipped.
    const byKind = new Map()
    for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
    for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${kind.padEnd(22)} ${CLASS_STATUS[kind] ?? "(no status recorded -- add one)"}`)
    }
    console.log("")
    for (const f of findings) console.log(`  ${f.kind.padEnd(22)} ${f.subject.padEnd(52)} ${f.evidence}`)
  }
  return 0
}

// The exit code is ASSIGNED rather than forced with `process.exit` so stdout and
// stderr are flushed before the process ends: on Windows a piped stderr write is
// asynchronous, and `process.exit` can truncate the very message this guard
// exists to deliver.
//
// The `--self-test` dispatch runs LAST, after the consts it reaches. While this
// block sat above `BASELINE_DEFAULT`/`ALLOWLIST_DEFAULT`, a case that drove
// `main()` died on `Cannot access 'BASELINE_DEFAULT' before initialization`, so
// no case drove the CLI at all -- and deleting the `--gate` block, the
// `--digest` block, the allowlist read or the stale-disposition check each left
// the suite fully green. Moving the dispatch is what makes those call sites
// testable; the `process.exit` form is kept as it was (its stdout-only flush
// behaviour is a recorded, measured-lossless pre-existing property).
if (args.includes("--self-test")) {
  const { ok, total } = runSelfTest()
  process.exit(ok === total && total > 0 ? 0 : 1)
}
process.exitCode = main()
