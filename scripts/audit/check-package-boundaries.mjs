#!/usr/bin/env node
// scripts/audit/check-package-boundaries.mjs
//
// The monorepo declares 82 workspace packages, but 117 imports reach directly
// into another package's `src/` by relative path (`../../../session-executor/
// src/...`), bypassing the exports map and the declared dependency graph. A
// full migration is a separate project; this gate makes the boundary stop
// getting WORSE: the current set is a baseline, and any NEW cross-package
// relative import fails.
//
// Usage: node scripts/audit/check-package-boundaries.mjs [--gate]
//   --gate  exit 1 when a violation is not in the baseline

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const BASELINE_PATH = join(ROOT, "scripts", "audit", "package-boundary-baseline.json")
const GROUPS = ["packages", "apps"]
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "release", "out", "coverage", ".turbo"])

function workspacePackages() {
  const found = []
  for (const group of GROUPS) {
    const groupDir = join(ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(groupDir, entry.name)
      const manifest = join(dir, "package.json")
      if (!existsSync(manifest)) continue
      const { name } = JSON.parse(readFileSync(manifest, "utf8"))
      found.push({ name, dir })
    }
  }
  return found
}

function sourceFiles(dir) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path)
    }
  }
  walk(dir)
  return files
}

const packages = workspacePackages()
const packageOf = (path) => packages
  .filter((pkg) => path === pkg.dir || path.startsWith(pkg.dir + sep))
  .sort((a, b) => b.dir.length - a.dir.length)[0]

const SPECIFIER = /["']((?:\.\.\/)+[^"']+)["']/g
function violations() {
  const found = new Map()
  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src")
    if (!existsSync(srcDir)) continue
    for (const file of sourceFiles(srcDir)) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1]
        if (!specifier.includes("/src/") && !specifier.endsWith("/src")) continue
        const target = resolve(dirname(file), specifier)
        const owner = packageOf(target)
        if (owner === undefined || owner.name === pkg.name) continue
        const key = `${pkg.name} -> ${relative(ROOT, target).split(sep).join("/")}`
        if (!found.has(key)) found.set(key, { importer: pkg.name, file: relative(ROOT, file).split(sep).join("/"), specifier })
      }
    }
  }
  return found
}

const gate = process.argv.includes("--gate")
const current = violations()
const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")))
  : new Set()

if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_PATH, JSON.stringify([...current.keys()].sort(), null, 2) + "\n")
  console.log(`package-boundaries: wrote ${current.size} baseline entr${current.size === 1 ? "y" : "ies"}`)
  process.exit(0)
}

const added = [...current.keys()].filter((key) => !baseline.has(key))
const removed = [...baseline].filter((key) => !current.has(key))

console.log(`package-boundaries: ${current.size} cross-package src import(s); baseline ${baseline.size}`)
for (const key of added) {
  const row = current.get(key)
  console.log(`  NEW  ${key}\n       ${row.file}  (${row.specifier})`)
}
if (removed.length > 0) console.log(`  ${removed.length} baseline entr${removed.length === 1 ? "y is" : "ies are"} gone (progress — update the baseline)`)

if (added.length > 0 && gate) {
  console.error(`\npackage boundaries: ${added.length} new cross-package src import(s). Import through the package entry or add a declared dependency instead.`)
  process.exit(1)
}
