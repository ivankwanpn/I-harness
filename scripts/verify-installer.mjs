#!/usr/bin/env node
// ============================================================================
// verify-installer.mjs -- real install/run/uninstall verification of the NSIS
// installer (test build, zero system writes).
//
// Hard rules (per milestone coordinate):
//   - NEVER launches a GUI installer: every exe runs with /S (silent) only,
//     asserted before each launch; nothing is ever spawned with a non-silent
//     argument set.
//   - Only the TEST exe (IH_NSIS_TEST build: RequestExecutionLevel user, no
//     PATH / registry / start-menu writes) is executed.
//   - The target directory is always OUTSIDE the repo: a fresh temp dir under
//     os.tmpdir().
//
// Flow (no mocks -- this runs the actual compiled artifacts):
//   1. rebuild installer artifacts via scripts/build-installer.mjs
//      (idempotent; downloads cached) so staging + the test exe are current.
//   2. silent-install the test exe into the temp dir via `/S /D=<tmp>`.
//   3. assert the installed tree mirrors installer/staging (File /r semantics)
//      and that the launchers really run: --version == <ver> on both cmd
//      files, `tui --help` exits 0, the bundled node.exe reports its version.
//   4. silent-uninstall (again /S-only), asserting the install dir is removed
//      (the NSIS uninstaller defers the final root-dir delete by ~1-3 s to its
//      temp-copy helper, so the check polls a few seconds).
//
// Prints a PASS/FAIL line per assertion; exits nonzero if any assertion fails.
// ============================================================================

import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs"
import { join, dirname, basename, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const APP_VERSION = process.env.IH_APP_VERSION ?? pkg.version ?? "0.1.0"
const NODE_RUNTIME_VERSION = process.env.IH_NODE_VERSION ?? "22.16.0"

const buildDir = join(repoRoot, "build")
const stagingDir = join(repoRoot, "installer", "staging")
const testExe = join(buildDir, `I-harness-Setup-${APP_VERSION}-test.exe`)
const normalExe = join(buildDir, `I-harness-Setup-${APP_VERSION}.exe`)

const installDir = join(tmpdir(), `i-harness-verify-${Date.now()}`)

const results = []
function assert(name, cond, detail = "") {
  const ok = !!cond
  results.push({ name, ok })
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` -- ${detail}` : ""}`)
}

function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

// Launch an installer/uninstaller exe SILENTLY. Refuses any non-silent args.
function runExeSilent(exePath, args, timeoutMs) {
  if (!args.includes("/S")) {
    throw new Error(`refusing to launch ${basename(exePath)} without /S (stray GUI install)`)
  }
  return new Promise((resolved) => {
    const child = spawn(exePath, args, { stdio: "ignore", windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      resolved({ code: -999, timedOut: true })
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolved({ code: -998, err: e.message })
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolved({ code, timedOut: false })
    })
  })
}

// Run a .cmd launcher through cmd.exe. `cmd /c "path" args` (single quoted
// path token) passed verbatim: node's default arg re-quoting mangles the
// inner quotes, so windowsVerbatimArguments is required.
function runLauncherCmd(relPath, args, timeoutMs = 60_000) {
  const abs = join(installDir, relPath)
  const cmdline = `"${abs}" ${args.join(" ")}`
  return new Promise((resolved) => {
    const child = spawn("cmd.exe", ["/d", "/c", cmdline], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, I_HARNESS_HOME: undefined },
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    const timer = setTimeout(() => {
      child.kill()
      resolved({ code: -999, out, timedOut: true })
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolved({ code: -998, out, err: e.message })
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolved({ code, out })
    })
  })
}

async function main() {
  console.log(`verify-installer v${APP_VERSION} -- artifact verification (IH_NSIS_TEST build)`)
  console.log(`\n[1/5] rebuilding installer artifacts (idempotent, cached downloads)`)
  const res = spawnSync(process.execPath, [join(repoRoot, "scripts", "build-installer.mjs")], {
    stdio: "inherit",
    cwd: repoRoot,
  })
  if (res.status !== 0) {
    console.error("[verify-installer] build-installer.mjs failed -- aborting verify")
    process.exit(1)
  }
  if (!existsSync(testExe)) {
    console.error(`[verify-installer] test exe missing after build: ${testExe}`)
    process.exit(1)
  }

  if (installDir.includes(" ")) {
    console.error(`[verify-installer] os.tmpdir() contains spaces (${installDir}) which break NSIS /D -- aborting`)
    process.exit(1)
  }
  console.log(`\n[2/5] silent install: ${basename(testExe)} /S /D=${installDir}`)
  if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true })
  const inst = await runExeSilent(testExe, ["/S", `/D=${installDir}`], 180_000)
  if (inst.err) {
    console.error(`[verify-installer] installer failed to start: ${inst.err}`)
    process.exit(1)
  }
  console.log(`  installer exit code: ${inst.code}${inst.timedOut ? " (TIMEOUT)" : ""}`)
  assert("silent install exits 0", inst.code === 0, inst.timedOut ? "timed out" : `code=${inst.code}`)

  console.log(`\n[3/5] installed-tree + runtime assertions`)
  assert("installed: i-harness.cmd present", existsSync(join(installDir, "i-harness.cmd")))
  assert("installed: ih.cmd present", existsSync(join(installDir, "ih.cmd")))
  assert("installed: dist/ih.mjs present", existsSync(join(installDir, "dist", "ih.mjs")))
  assert("installed: node/node.exe present", existsSync(join(installDir, "node", "node.exe")))
  assert("installed: uninstall.exe present", existsSync(join(installDir, "uninstall.exe")))

  // every staged file (File /r "staging\*" mirroring) landed at staging/<rel>
  // -> $INSTDIR/<rel>
  const missing = []
  for (const f of walkFiles(stagingDir)) {
    const instF = join(installDir, relative(stagingDir, f))
    if (!existsSync(instF)) missing.push(relative(stagingDir, f))
  }
  assert(`installed tree covers staging (${missing.length} missing)`, missing.length === 0, missing.slice(0, 5).join(" ; "))

  const verifyLauncher = async (rel, args, label) => {
    const r = await runLauncherCmd(rel, args)
    if (r.timedOut) {
      assert(`${label} exits 0`, false, "timed out")
      return r
    }
    assert(`${label} exits 0`, r.code === 0, `code=${r.code}\n${r.out.trim().slice(0, 300)}`)
    return r
  }

  const v1 = await verifyLauncher("i-harness.cmd", ["--version"], "i-harness.cmd --version")
  assert("i-harness.cmd --version prints version", v1.out.includes(APP_VERSION), v1.out.trim().slice(0, 120))
  const v2 = await verifyLauncher("ih.cmd", ["--version"], "ih.cmd --version")
  assert("ih.cmd --version prints version", v2.out.includes(APP_VERSION), v2.out.trim().slice(0, 120))
  const tuiHelp = await verifyLauncher("ih.cmd", ["tui", "--help"], "ih.cmd tui --help")
  assert("ih.cmd tui --help exits 0 (usage)", tuiHelp.code === 0, tuiHelp.out.trim().slice(0, 120))
  const nodeV = await verifyLauncher("node\\node.exe", ["--version"], "bundled node.exe --version")
  assert(
    "bundled node.exe reports runtime version",
    nodeV.out.trim().startsWith(`v${NODE_RUNTIME_VERSION}`),
    nodeV.out.trim()
  )

  console.log(`\n[4/5] silent uninstall: uninstall.exe /S`)
  const uninst = await runExeSilent(join(installDir, "uninstall.exe"), ["/S"], 60_000)
  console.log(`  uninstaller exit code: ${uninst.code}${uninst.timedOut ? " (TIMEOUT)" : ""}`)
  assert("uninstaller exits 0", uninst.code === 0, uninst.timedOut ? "timed out" : `code=${uninst.code}`)

  // The NSIS uninstaller defers the final $INSTDIR root-dir delete to its
  // temp-copy helper, which acts ~1-3s after the main process exits: poll.
  let gone = false
  for (let i = 0; i < 20 && !gone; i++) {
    if (!existsSync(installDir)) {
      gone = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  assert("install dir removed after uninstall (polled <=10s)", gone, installDir)

  console.log(`\n[5/5] cleanup`)
  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true })
    console.log("  leftover install dir force-removed")
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== VERIFY ${failed.length === 0 ? "PASS" : `FAIL (${failed.length}/${results.length})`} ===`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("[verify-installer] ERROR:", e)
  process.exit(1)
})
