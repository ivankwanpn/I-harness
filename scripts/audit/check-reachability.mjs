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
  put("packages/epsilon/src/index.ts", 'export * from "./impl"\n')
  put("packages/epsilon/src/use.ts", 'import { ReExported } from "./impl"\nReExported()\n')

  return dir
}

const SCANNERS = []          // filled in by Tasks 2-4
const SELF_TEST_CASES = []   // { name, run(fixtureRoot) -> string[] } expected subjects

// ------------------------------------------------- class 1: unused export
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^export\s*(?:type\s*)?\{([^}]*)\}/gm

const EXPORT_STAR = /^export\s*\*\s*from\s*["']([^"']+)["']/gm

function exportedNames(text) {
  const names = new Set()
  for (const m of text.matchAll(EXPORT_DECL)) names.add(m[1])
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(",")) {
      const t = part.trim()
      if (!t) continue
      const alias = t.split(/\s+as\s+/)
      names.add((alias[1] ?? alias[0]).trim())
    }
  }
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

/** Exports of `file`, following `export * from "./sibling"` into the sibling
 *  and recursing. Returns name -> the set of rel paths that DECLARE it, because
 *  a declaration site is not a use of its own name: without that, following a
 *  re-export would mark the whole re-exported surface used. `seen` terminates a
 *  re-export cycle. */
function exportedNamesDeep(file, byRel, seen = new Set([file.rel])) {
  const names = new Map()
  const add = (name, rel) => {
    if (!names.has(name)) names.set(name, new Set())
    names.get(name).add(rel)
  }
  for (const name of exportedNames(file.text)) add(name, file.rel)
  for (const m of file.text.matchAll(EXPORT_STAR)) {
    const target = resolveModule(m[1], file.rel, byRel)
    if (!target || seen.has(target.rel)) continue
    seen.add(target.rel)
    for (const [name, origins] of exportedNamesDeep(target, byRel, seen)) {
      for (const o of origins) add(name, o)
    }
  }
  return names
}

/** A name is "used" when some NON-TEST file other than the one that DECLARES
 *  it mentions it as a word. Package scoping is deliberately absent: a symbol
 *  imported relatively and called inside its own package is used on a
 *  production path just as much as one imported by a sibling package. */
function scanUnusedExports(files) {
  const prod = files.filter((f) => !f.test)
  const byRel = new Map(prod.map((f) => [f.rel, f]))
  const findings = []
  for (const entry of prod.filter((f) => /^packages\/[^/]+\/src\/index\.ts$/.test(f.rel))) {
    const pkg = "@i-harness/" + entry.rel.split("/")[1]
    for (const [name, origins] of exportedNamesDeep(entry, byRel)) {
      const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
      const used = prod.some((f) => !origins.has(f.rel) && word.test(f.text))
      if (!used) findings.push({ kind: "unused-export", subject: `${pkg}#${name}`, evidence: entry.rel })
    }
  }
  return findings
}

SCANNERS.push(scanUnusedExports)

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
      .filter((s) => s.startsWith("@i-harness/epsilon#"))
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
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "lib") continue
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
