#!/usr/bin/env node
/**
 * M45 G1 / M55: verify-dist — the build-dist gate (fails loud).
 *
 *   node scripts/verify-dist.mjs [--out dist]
 *
 * Asserts layout + real smoke on the built bundle:
 *   (a) node <out>/ih.mjs --version   → stdout "0.1.0", exit 0
 *   (b) node <out>/ih.mjs             → stderr "usage: i-harness", exit 1
 *       and node <out>/ih.mjs tui     → the same. M65 T1 replaced the old
 *       "(b) tui --help" smoke: the TUI it printed for is deleted, and the
 *       behaviour that replaced M44's grok-style default — a bare launch (or a
 *       removed subcommand) is a usage error — is what must hold in dist;
 *   (c) node <out>/ih.mjs help        → stderr "usage: i-harness", exit 0
 * M55 self-sufficiency (no source checkout, no tsx):
 *   (d) hidden `__dist-selfcheck`     → the windows-acl seam confines through
 *       the bundled runner. M65 T1 removed the three probes whose subject was
 *       the TUI (the inline engine, the /minimal relaunch argv — which this
 *       script used to re-execute — and the --attach SDK spawn): all three
 *       lived in @i-harness/tui-app, which is deleted. The confinement probe
 *       still has a subject and is kept;
 *   (e) <out>/runner.mjs              → the windows-acl runner bundle exists,
 *       honours its exit-127 failure contract, and really confines (child
 *       exit code mirrored);
 *   (f) node <out>/ih.mjs sdk         → the bundle re-enters ITSELF for the SDK
 *       stdio server and answers an NDJSON JSON-RPC `initialize`. M65 T1
 *       restored this assertion: the TUI helper that used to drive it
 *       (spawnSdkSubprocess / buildSdkSpawnArgs) was deleted, but the SUBJECT —
 *       the dist bundle's `sdk` surface — survives, so the probe is written
 *       here against the bundle. It is platform-independent, which is also what
 *       keeps this gate non-vacuous off win32, where (d1) can only assert its
 *       own skip line.
 * Every assertion failure prints the full stdout/stderr of the failing
 * command and exits 1 (non-zero) — never settles for a silent pass.
 */

import { spawn, spawnSync } from "node:child_process"
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

// M65 T1: the bare launch and the removed `tui` subcommand are usage errors in
// the bundle too. This replaces the old "(b) tui --help" smoke — its subject is
// deleted, and what replaced M44's grok-style default (usage on stderr, exit 1,
// nothing on stdout) is the behaviour this gate must pin in dist.
for (const [label, args] of [["bare launch", []], ["removed subcommand 'tui'", ["tui"]]]) {
  const t = Date.now()
  const r = spawnSync(process.execPath, [IH, ...args], { cwd: ROOT, encoding: "utf8" })
  const detail = `  exit: ${r.status}\n  stdout:\n${r.stdout}\n  stderr:\n${r.stderr}`
  assert(r.status === 1, `(b) ${label} exits 1 ${getDuration(t)}`, detail)
  assert(r.stderr.includes("usage: i-harness"), `(b) ${label} prints 'usage: i-harness' (stderr)`, detail)
  assert(r.stdout === "", `(b) ${label} writes nothing to stdout`, detail)
}

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

// (d) hidden self-check: the windows-acl confinement probe (M65 T1 removed the
// three TUI-subject probes; see the header).
{
  const t = Date.now()
  const r = spawnSync(process.execPath, [IH, "__dist-selfcheck"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 })
  const detail = `  exit: ${r.status}\n  stdout:\n${r.stdout}\n  stderr:\n${r.stderr}`
  assert(r.status === 0, `(d) __dist-selfcheck exits 0 ${getDuration(t)}`, detail)
  assert(
    process.platform === "win32"
      ? r.stdout.includes("acl-seam: ok")
      : r.stdout.includes("acl-seam: skipped (non-win32)"),
    "(d1) the self-check's confinement probe ran (or declared its platform skip — nothing else is probed off win32)",
    detail,
  )
  const relaunchLine = r.stdout.split(/\r?\n/).find((line) => line.startsWith("relaunch-argv: "))
  assert(
    relaunchLine === undefined,
    "(d2) no relaunch-argv line remains (its producer, the TUI's relaunchArgs, is deleted)",
    `${detail}\n  line: ${relaunchLine}`,
  )
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

// (f) dist-level SDK stdio server — the restored `--attach`-era probe.
//
// What it asserts: `node ih.mjs sdk` re-enters the bundle, speaks NDJSON
// JSON-RPC 2.0 over stdio, and answers `initialize` with a numeric
// protocolVersion (packages/sdk/src/server.ts:266-275). No TUI helper is
// involved — the frame is written by hand with the same shape the SDK client
// sends (packages/sdk/src/protocol.ts:467 makeRequest + :534 encodeFrame), which
// is what makes this check possible after M65 T1 deleted
// spawnSdkSubprocess/buildSdkSpawnArgs.
//
// IH_CONFIG_DIR is pinned to a fresh temp dir: `sdk` loads the provider runtime
// at startup, and a developer's own settings must not be read (and nothing may
// be written into this repo) by a build gate.
function sdkInitializeProbe() {
  const configDir = mkdtempSync(join(tmpdir(), "ih-verify-dist-sdk-"))
  const child = spawn(process.execPath, [IH, "sdk"], {
    cwd: ROOT,
    env: { ...process.env, IH_CONFIG_DIR: configDir },
  })
  let stdout = ""
  let stderr = ""
  let timer
  const outcome = new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(value)
    }
    timer = setTimeout(
      () => finish({ error: `no initialize response within 45 s\n  stdout:\n${stdout}\n  stderr:\n${stderr}` }),
      45_000,
    )
    child.stdout.on("data", (d) => {
      stdout += String(d)
      for (const line of stdout.split(/\r?\n/)) {
        if (line.trim() === "") continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame !== null && typeof frame === "object" && frame.id === 1) finish({ frame })
      }
    })
    child.stderr.on("data", (d) => { stderr += String(d) })
    child.on("error", (e) => finish({ error: `spawn failed: ${e.message}` }))
    child.on("exit", (code) => finish({ error: `sdk exited (code ${code}) before answering\n  stdout:\n${stdout}\n  stderr:\n${stderr}` }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
  })
  return outcome.finally(() => { rmSync(configDir, { recursive: true, force: true }) })
}

{
  const t = Date.now()
  const r = await sdkInitializeProbe()
  const protocolVersion = r.frame?.result?.protocolVersion
  assert(
    typeof protocolVersion === "number",
    `(f) node ih.mjs sdk answers an NDJSON initialize from the bundle ${getDuration(t)}`,
    r.error ?? `  frame: ${JSON.stringify(r.frame)}`,
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
