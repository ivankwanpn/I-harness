#!/usr/bin/env node
// scripts/audit/extract-ih-surface.mjs
//
// Phase 0 of docs/superpowers/specs/2026-09-11-backend-inventory-sevenway-design.md
//
// Extracts the public surface of every IN-SCOPE I-harness package. The point is
// completeness that does not depend on anyone remembering: the inventory doc's
// package list is generated from this file, so a package cannot be silently
// omitted from the audit. Design §8 threshold 1 requires 65/65 coverage, and
// this script is what makes that number checkable rather than asserted.
//
// Scope per design §2: every packages/* EXCEPT tui, tui-core and web (frontend),
// plus apps/cli. web-host / sdk / acp are backend and stay in.
//
// Usage: node scripts/audit/extract-ih-surface.mjs [--out <dir>]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const OUT_DIR = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, "docs/audit/data")

/** Excluded per design §2 -- the unfinished frontend, not the subject. */
const EXCLUDED_PACKAGES = new Set(["tui", "tui-core", "web"])
const EXCLUDED_APPS = new Set(["tui"])

function slurp(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

function readJson(p) {
  try {
    return JSON.parse(slurp(p))
  } catch {
    return null
  }
}

/**
 * Named exports of a module entry point. Deliberately textual: a real TS parse
 * would need the workspace's compiler, and the failure mode we care about --
 * claiming a package exposes something it does not -- is caught by the agent
 * pass citing file:line. This gives the inventory its checklist of symbol names.
 */
function exportedSymbols(abs) {
  const text = slurp(abs)
  if (!text) return []
  const names = new Set()
  // export function foo / export async function foo / export class Foo
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  // export { a, b as c }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim()
      if (!t) continue
      const as = t.split(/\s+as\s+/)
      names.add((as[1] ?? as[0]).trim())
    }
  }
  // export * as ns from "..."
  for (const m of text.matchAll(/export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // export type Foo / export interface Foo
  for (const m of text.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return [...names].sort()
}

function collect(areaDir, kind) {
  const out = []
  if (!existsSync(areaDir)) return out
  for (const e of readdirSync(areaDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (kind === "package" && EXCLUDED_PACKAGES.has(e.name)) continue
    if (kind === "app" && EXCLUDED_APPS.has(e.name)) continue
    const dir = join(areaDir, e.name)
    const pkg = readJson(join(dir, "package.json"))
    if (!pkg) {
      out.push({ name: e.name, kind, error: "no package.json", inScope: true })
      continue
    }
    const srcDir = join(dir, "src")
    const entryCandidates = ["index.ts", "index.tsx", "main.ts"]
    let entry = null
    for (const c of entryCandidates) {
      if (existsSync(join(srcDir, c))) {
        entry = join(srcDir, c)
        break
      }
    }
    const symbols = entry ? exportedSymbols(entry) : []
    // count source files so a stub package is visible as such
    let srcFiles = 0
    const stack = [srcDir]
    while (stack.length) {
      const d = stack.pop()
      let ents
      try {
        ents = readdirSync(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const x of ents) {
        if (x.isDirectory()) stack.push(join(d, x.name))
        else if (/\.tsx?$/.test(x.name)) srcFiles++
      }
    }
    out.push({
      name: e.name,
      kind,
      packageName: pkg.name ?? null,
      version: pkg.version ?? null,
      inScope: true,
      entry: entry ? relative(ROOT, entry).replace(/\\/g, "/") : null,
      srcFiles,
      exportCount: symbols.length,
      symbols,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const packages = collect(join(ROOT, "packages"), "package")
const apps = collect(join(ROOT, "apps"), "app")

const result = {
  extractedAt: new Date().toISOString().slice(0, 10),
  scope: {
    rule: "packages/* except tui, tui-core, web; plus apps/*",
    excluded: [...EXCLUDED_PACKAGES],
  },
  packageCount: packages.length,
  appCount: apps.length,
  packages,
  apps,
}

mkdirSync(OUT_DIR, { recursive: true })
const file = join(OUT_DIR, "2026-09-11-ih-surface.json")
writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf8")

console.log(`packages in scope: ${result.packageCount}`)
console.log(`apps:              ${result.appCount}`)
const empty = packages.filter((p) => p.exportCount === 0)
if (empty.length) {
  console.log(`\npackages exporting no symbols from src/index.ts (${empty.length}):`)
  for (const p of empty) console.log(`  ${p.name.padEnd(24)} srcFiles=${p.srcFiles} entry=${p.entry ?? "-"}`)
}
console.log(`\nwrote ${relative(ROOT, file).replace(/\\/g, "/")}`)
