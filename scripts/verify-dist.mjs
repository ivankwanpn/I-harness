#!/usr/bin/env node
/**
 * M45 G1 / M55: verify-dist — the build-dist gate (fails loud).
 *
 *   node scripts/verify-dist.mjs [--out dist]
 *
 * Asserts layout + real smoke on the built bundle:
 *   (a) node <out>/ih.mjs --version   → stdout "0.1.0", exit 0
 *   (b) node <out>/ih.mjs tui --help  → stdout "usage: tui", exit 0
 *   (c) node <out>/ih.mjs help        → stderr "usage: i-harness", exit 0
 * M55 self-sufficiency (no source checkout, no tsx):
 *   (d) hidden `__dist-selfcheck`     → minimal inline engine loads from the
 *       bundle, the /minimal relaunch argv re-execs the bundle (and that argv
 *       is EXECUTED here), the --attach SDK spawn handshakes over stdio, and
 *       the windows-acl seam confines through the bundled runner;
 *   (e) <out>/runner.mjs              → the windows-acl runner bundle exists,
 *       honours its exit-127 failure contract, and really confines (child
 *       exit code mirrored).
 * Every assertion failure prints the full stdout/stderr of the failing
 * command and exits 1 (non-zero) — never settles for a silent pass.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
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
const RUNNER = join(OUT, "runner.mjs")
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

// ------------------------------------------- M55: dist self-sufficiency smoke

/** One real confined spawn through the runner bundle (read-only needs no
 * DACL grants — token creation + restricted spawn + exit mirroring). */
function aclRunnerSpawn() {
  const tmp = mkdtempSync(join(tmpdir(), "ih-verify-dist-acl-"))
  try {
    const workspace = join(tmp, "ws")
    mkdirSync(workspace)
    return spawnSync(
      process.execPath,
      [RUNNER, "--workspace", workspace, "--temp", tmp, "--mode", "read-only", "--", process.execPath, "-e", "process.exit(7)"],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// (d) hidden self-check: minimal inline engine + relaunch argv + SDK spawn.
{
  const t = Date.now()
  const r = spawnSync(process.execPath, [IH, "__dist-selfcheck"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 })
  const detail = `  exit: ${r.status}\n  stdout:\n${r.stdout}\n  stderr:\n${r.stderr}`
  assert(r.status === 0, `(d) __dist-selfcheck exits 0 ${getDuration(t)}`, detail)
  assert(r.stdout.includes("minimal-host: ok"), "(d1) minimal inline engine loads from the bundle", detail)
  assert(r.stdout.includes("sdk-spawn: ok"), "(d3) --attach SDK spawn handshakes over stdio", detail)
  assert(
    process.platform !== "win32" || r.stdout.includes("acl-seam: ok"),
    "(d4) windows-acl seam confines through the bundled runner",
    detail,
  )

  const relaunchLine = r.stdout.split(/\r?\n/).find((line) => line.startsWith("relaunch-argv: "))
  assert(relaunchLine !== undefined, "(d2) self-check prints the /minimal relaunch argv", detail)
  if (relaunchLine !== undefined) {
    const argv = JSON.parse(relaunchLine.slice("relaunch-argv: ".length))
    const shapeOk = Array.isArray(argv) && argv.length > 0 && resolve(String(argv[0])) === IH && !argv.includes("tsx")
    assert(
      shapeOk,
      "(d2) dist relaunch argv re-execs the bundle and drops the tsx loader",
      `${detail}\n  argv: ${JSON.stringify(argv)}`,
    )
    if (shapeOk) {
      const t2 = Date.now()
      const relaunch = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
      assert(
        relaunch.status === 0,
        `(d2) executing that relaunch argv exits 0 ${getDuration(t2)}`,
        `  exit: ${relaunch.status}\n  stdout:\n${relaunch.stdout}\n  stderr:\n${relaunch.stderr}`,
      )
    }
  }
}

// (e) the windows-acl runner bundle: present + failure contract + real confine.
{
  assert(existsSync(RUNNER), `(e) acl runner bundle present: ${RUNNER}`, `missing ${RUNNER} — build-dist emits it beside ih.mjs`)
  const t = Date.now()
  const noArgs = spawnSync(process.execPath, [RUNNER], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
  assert(
    noArgs.status === 127 && noArgs.stderr.includes("windows-acl-run: "),
    `(e) acl runner failure contract: exit 127 + signature ${getDuration(t)}`,
    `  exit: ${noArgs.status}\n  stderr:\n${noArgs.stderr}`,
  )
  const t2 = Date.now()
  const confined = aclRunnerSpawn()
  assert(
    confined.status === 7,
    `(e) confined spawn mirrors the child exit code (7) ${getDuration(t2)}`,
    `  exit: ${confined.status}\n  stdout:\n${confined.stdout}\n  stderr:\n${confined.stderr}`,
  )
}

// ---------------------------------------------------------------- verdict

const ihSize = existsSync(IH) ? statSync(IH).size : 0
console.log(`\n[verify-dist] bundle size: ${(ihSize / 1024).toFixed(1)} KiB (ih.mjs)`)
if (failed) {
  console.error("[verify-dist] RESULT: FAIL")
  process.exit(1)
}
console.log("[verify-dist] RESULT: PASS")
