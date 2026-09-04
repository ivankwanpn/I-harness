#!/usr/bin/env node
/**
 * M45 G1: verify-dist — the build-dist gate (fails loud).
 *
 *   node scripts/verify-dist.mjs [--out dist]
 *
 * Asserts layout + real smoke on the built bundle:
 *   (a) node <out>/ih.mjs --version   → stdout "0.1.0", exit 0
 *   (b) node <out>/ih.mjs tui --help  → stdout "usage: tui", exit 0
 *   (c) node <out>/ih.mjs help        → stderr "usage: i-harness", exit 0
 * Every assertion failure prints the full stdout/stderr of the failing
 * command and exits 1 (non-zero) — never settles for a silent pass.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const argv = process.argv.slice(2)
let out = "dist"
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i]
  else if (typeof argv[i] === "string" && argv[i].startsWith("--out=")) out = argv[i].slice("--out=".length)
  else {
    console.error(`[verify-dist] FAIL: unknown argument: ${argv[i]} (usage: node scripts/verify-dist.mjs [--out dist])`)
    process.exit(1)
  }
}
const OUT = resolve(ROOT, out)
const IH = join(OUT, "ih.mjs")
const NODES_DIR = join(OUT, "node_modules")

let failed = false

function fail(reason) {
  failed = true
  console.error(`[verify-dist] FAIL: ${reason}`)
}

function assert(cond, message, details) {
  if (cond) {
    console.log(`[verify-dist] ok: ${message}`)
  } else {
    fail(`${message}${details !== undefined ? `\n${details}` : ""}`)
  }
}

function getDuration(start) {
  return `(${Date.now() - start} ms)`
}

/** Find a *.node file anywhere under dir (node-pty / koffi native bindings). */
function hasNodeFile(dir) {
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (typeof entry === "string" && entry.endsWith(".node")) return true
  }
  return false
}

/** Find the rg binary (rg.exe / rg) under the @vscode/ripgrep install. */
function hasRgBinary(dir) {
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (typeof entry === "string" && (entry.endsWith("/rg.exe") || entry.endsWith("/rg") || entry.endsWith("\\rg.exe") || entry.endsWith("\\rg"))) {
      return true
    }
  }
  return false
}

/** Platform-triplet package names (koffi/@vscode/ripgrep native siblings). */
const triplet = `${process.platform}-${process.arch}` // e.g. win32-x64

// ---------------------------------------------------------------- layout checks

if (!existsSync(OUT)) {
  fail(`out dir missing: ${OUT} — run node scripts/build-dist.mjs first`)
  process.exit(1)
}
assert(existsSync(IH), `bundle present: ${IH}`, `missing ${IH}`)
assert(existsSync(join(OUT, "package.json")), "dist package.json present")
assert(existsSync(join(OUT, "README-dist.txt")), "README-dist.txt present")
assert(
  existsSync(join(OUT, "model-catalog.json")),
  "model-catalog.json beside the bundle",
  "missing model-catalog.json — @i-harness/provider reads it at module load (new URL relative to the bundle)",
)
assert(existsSync(NODES_DIR), `native node_modules present: ${NODES_DIR}`)

for (const name of ["node-pty", "koffi", "@vscode/ripgrep"]) {
  const p = join(NODES_DIR, name)
  assert(existsSync(p), `native deployed: ${name}`, `missing ${p}`)
}
assert(
  existsSync(join(NODES_DIR, `@koromix/koffi-${triplet}`)),
  `koffi platform native deployed: @koromix/koffi-${triplet}`,
  `missing @koromix/koffi-${triplet} (koffi's loader looks it up at node_modules/@koromix/koffi-<triplet>)`,
)
assert(
  existsSync(join(NODES_DIR, `@vscode/ripgrep-${triplet}`)),
  `ripgrep platform native deployed: @vscode/ripgrep-${triplet}`,
  `missing @vscode/ripgrep-${triplet} (rgPath resolves it via require.resolve)`,
)
assert(hasNodeFile(join(NODES_DIR, "node-pty")), "node-pty native binding (.node) shipped")
assert(
  hasNodeFile(join(NODES_DIR, "koffi")) || hasNodeFile(join(NODES_DIR, "@koromix")),
  "koffi native binding (.node) shipped",
)
assert(hasRgBinary(join(NODES_DIR, "@vscode")), "@vscode/ripgrep rg binary shipped")

// ---------------------------------------------------------------- smoke

function smoke(label, args, describe) {
  const t = Date.now()
  const r = spawnSync(process.execPath, [IH, ...args], { cwd: ROOT, encoding: "utf8" })
  const detail = `  exit: ${r.status}\n  stdout:\n${r.stdout}\n  stderr:\n${r.stderr}`
  assert(r.status === 0, `${label} exits 0 ${getDuration(t)}`, detail)
  describe(r, detail)
  return r
}

smoke("(a) --version", ["--version"], (r, detail) => {
  assert(r.stdout.trim() === "0.1.0", "(a) --version prints 0.1.0", detail)
})

smoke("(b) tui --help", ["tui", "--help"], (r, detail) => {
  assert(r.stdout.includes("usage: tui"), "(b) tui --help prints 'usage: tui'", detail)
})

smoke("(c) help", ["help"], (r, detail) => {
  assert(r.stderr.includes("usage: i-harness"), "(c) help prints 'usage: i-harness' (stderr)", detail)
})

// ---------------------------------------------------------------- verdict

const ihSize = existsSync(IH) ? statSync(IH).size : 0
console.log(`\n[verify-dist] bundle size: ${(ihSize / 1024).toFixed(1)} KiB (ih.mjs)`)
if (failed) {
  console.error("[verify-dist] RESULT: FAIL")
  process.exit(1)
}
console.log("[verify-dist] RESULT: PASS")
