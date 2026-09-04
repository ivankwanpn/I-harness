#!/usr/bin/env node
// ============================================================================
// build-installer.mjs — build the NSIS self-contained installer for I-harness.
//
// Steps (all cache-friendly; network steps are skipped-if-cached):
//   1. App payload: resolve `<repo>/dist` — if `dist/ih.mjs` is missing, run
//      G1's `scripts/build-dist.mjs` (idempotent) to produce it.
//   2. Node runtime: ensure `build/node-win-x64/node.exe` — download the
//      official node zip from nodejs.org if the cache is empty, then keep
//      only what the installer ships (node.exe + *.dll + LICENSE).
//   3. Stage `installer/staging/{dist,node}` + the two .cmd launchers
//      (gitignored build artifact consumed by installer/ih.nsi).
//   4. makensis: locate `makensis.exe` (env override, build/tools/makensis,
//      PATH) or download the portable NSIS zip from sourceforge, then compile
//      BOTH builds:
//        build/I-harness-Setup-<ver>.exe        (normal: admin, PATH/reg)
//        build/I-harness-Setup-<ver>-test.exe   (IH_NSIS_TEST: user, no
//                                                system writes)
//
// Env overrides:
//   IH_APP_VERSION   version string (default: package.json version)
//   IH_NODE_VERSION  bundled node runtime version (default 22.16.0)
//   IH_MAKENSIS      absolute path to makensis.exe
//   --dist-dir <dir> override the app payload source (CI / smoke hook; the
//                    payload must satisfy the same dist contract)
//
// Network errors get explicit messages with the URLs involved.
// ============================================================================

import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, writeFileSync, statSync, readFileSync, createWriteStream } from "node:fs"
import { join, dirname, basename, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import { get as httpsGet } from "node:https"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const APP_VERSION = process.env.IH_APP_VERSION ?? pkg.version ?? "0.1.0"
const NODE_RUNTIME_VERSION = process.env.IH_NODE_VERSION ?? "22.16.0"
const NODE_ZIP_URL = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/node-v${NODE_RUNTIME_VERSION}-win-x64.zip`
const NSIS_VERSION = process.env.IH_NSIS_VERSION ?? "3.11"
const NSIS_ZIP_URL =
  process.env.IH_NSIS_URL ??
  `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`

const buildDir = join(repoRoot, "build")
const downloadsDir = join(buildDir, "downloads")
const stagingDir = join(repoRoot, "installer", "staging")
const runtimeDir = join(buildDir, "node-win-x64")
const toolsDir = join(buildDir, "tools")

// -- 0. small utils ----------------------------------------------------------

function fail(msg) {
  console.error(`[build-installer] ERROR: ${msg}`)
  process.exit(1)
}

async function step(name, fn) {
  console.log(`\n=== ${name} ===`)
  return fn()
}

async function runAsync(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot, ...opts })
    let out = ""
    child.stdout?.on("data", (d) => (out += d))
    child.stderr?.on("data", (d) => (out += d))
    child.on("exit", (code) => resolvePromise({ code, out }))
    child.on("error", (err) => resolvePromise({ code: -1, out: err.message }))
  })
}

// -- 1. payload: dist --------------------------------------------------------

async function ensureDist() {
  let distDir = join(repoRoot, "dist")
  const distArgIdx = process.argv.indexOf("--dist-dir")
  if (distArgIdx !== -1) distDir = resolve(process.argv[distArgIdx + 1])

  if (existsSync(join(distDir, "ih.mjs"))) {
    console.log(`payload present: ${relative(repoRoot, distDir)}/ih.mjs`)
    return distDir
  }
  const buildDist = join(repoRoot, "scripts", "build-dist.mjs")
  if (!existsSync(buildDist)) {
    fail(
      `${relative(repoRoot, distDir)}/ih.mjs missing and scripts/build-dist.mjs ` +
        `is not present — the dist pipeline (milestone M45 G1) must land before ` +
        `the installer can be built. Nothing was downloaded.`
    )
  }
  console.log(`payload missing (${relative(repoRoot, distDir)}/ih.mjs) — running scripts/build-dist.mjs (idempotent)`)
  await runAsync(process.execPath, [buildDist], { stdio: "inherit" })
  if (!existsSync(join(distDir, "ih.mjs"))) {
    fail(`build-dist.mjs finished but ${relative(repoRoot, distDir)}/ih.mjs is still missing`)
  }
  return distDir
}

// -- 2. node runtime ---------------------------------------------------------

function findFiles(dir, predicate, depth = 0) {
  if (!existsSync(dir) || depth > 6) return []
  let out = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.endsWith(".lock")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out = out.concat(findFiles(p, predicate, depth + 1))
    else if (predicate(p)) out.push(p)
  }
  return out
}

function download(url, dest, label) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`cached: ${label}`)
    return Promise.resolve()
  }
  if (existsSync(dest)) rmSync(dest, { force: true }) // stale zero-byte cache
  mkdirSync(dirname(dest), { recursive: true })
  return new Promise((resolvePromise, reject) => {
    const req = (u, redirects) => {
      httpsGet(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume()
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, u).href
          req(next, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode} for ${u}`))
          return
        }
        const len = Number(res.headers["content-length"] ?? 0)
        let wrote = 0
        let lastPct = -1
        const file = createWriteStream(dest)
        // wait for the stream's 'finish' (all bytes flushed to disk) BEFORE
        // resolving — resolving on the http 'end' alone can fire while the
        // write stream still buffers, and a process.exit(1) shortly after
        // would leave a truncated/empty file in the cache.
        res.on("data", (chunk) => {
          wrote += chunk.length
          if (len > 0) {
            const pct = Math.floor((wrote / len) * 100)
            if (pct % 25 === 0 && pct !== lastPct) {
              lastPct = pct
              process.stdout.write(`\r  downloading ${label} ${pct}% (${(wrote / 1e6).toFixed(1)}/${(len / 1e6).toFixed(1)} MB)`)
            }
          }
        })
        res.on("error", (e) => reject(new Error(`${label} download failed: ${e.message}`)))
        file.on("error", (e) => reject(new Error(`${label} write failed: ${e.message}`)))
        file.on("finish", () => {
          if (wrote === 0) reject(new Error(`${label} arrived empty (${url})`))
          process.stdout.write(`\r  downloaded ${label}: ${(wrote / 1e6).toFixed(1)} MB\n`)
          resolvePromise()
        })
        res.pipe(file)
      }).on("error", (e) => reject(new Error(`${label} download failed: ${e.message}`)))
    }
    req(url, 0)
  })
}

async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const tarPath = join(systemRoot, "System32", "tar.exe")
  if (existsSync(tarPath)) {
    const res = spawnSync(tarPath, ["-xf", zipPath, "-C", destDir], { encoding: "utf8" })
    if (res.status === 0) {
      console.log(`extracted ${relative(repoRoot, zipPath)} via Windows tar.exe`)
      return
    }
    console.warn(`[build-installer] tar.exe failed (${res.status}) — falling back to PowerShell Expand-Archive`)
  }
  const ps = await runAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`],
    { allowFail: false }
  )
  if (ps.code !== 0) fail(`PowerShell Expand-Archive failed for ${zipPath}:\n${ps.out}`)
  console.log(`extracted ${relative(repoRoot, zipPath)} via PowerShell Expand-Archive`)
}

async function ensureNodeRuntime() {
  const nodeExe = join(runtimeDir, "node.exe")
  if (existsSync(nodeExe)) {
    console.log(`runtime cached: node v${NODE_RUNTIME_VERSION} at ${relative(repoRoot, nodeExe)}`)
    return runtimeDir
  }
  const zipPath = join(downloadsDir, `node-v${NODE_RUNTIME_VERSION}-win-x64.zip`)
  console.log(`fetching official node zip: ${NODE_ZIP_URL}`)
  await download(NODE_ZIP_URL, zipPath, `node-v${NODE_RUNTIME_VERSION}-win-x64.zip`)

  const extractDir = join(buildDir, `nsisdl-node-v${NODE_RUNTIME_VERSION}-win-x64`)
  await extractZip(zipPath, extractDir)

  // flatten: the zip root folder holds node.exe (+ DLLs + LICENSE + npm)
  const candidates = findFiles(extractDir, (p) => ['node.exe', 'LICENSE'].includes(basename(p)))
  const nodeExeSrc = candidates.find((p) => basename(p) === "node.exe")
  if (!nodeExeSrc) fail(`extracted node zip does not contain node.exe — corrupt download? ${zipPath}`)
  const root = dirname(nodeExeSrc)
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === "README.md" || name === "CHANGELOG.md") continue
    const p = join(root, name)
    if (statSync(p).isFile()) {
      mkdirSync(runtimeDir, { recursive: true })
      copyFileSync(p, join(runtimeDir, name))
    }
  }
  if (!existsSync(nodeExe)) fail(`copying runtime failed: ${nodeExe} missing`)
  const sizeMb = (statSync(nodeExe).size / 1e6).toFixed(1)
  console.log(`runtime staged: node.exe (${sizeMb} MB) + LICENSE(+dlls) -> ${relative(repoRoot, runtimeDir)}`)
  return runtimeDir
}

// -- 3. staging --------------------------------------------------------------

function writeCmdLaunchers() {
  const body = [
    "@echo off",
    '"%~dp0node\\node.exe" "%~dp0dist\\ih.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n")
  for (const name of ["i-harness", "ih"]) {
    writeFileSync(join(stagingDir, `${name}.cmd`), body, "latin1")
  }
  console.log(`wrote launchers: i-harness.cmd, ih.cmd`)
}

function cpTree(src, dest, filter) {
  for (const name of readdirSync(src)) {
    if (filter && !filter(name)) continue
    const from = join(src, name)
    const to = join(dest, name)
    const st = statSync(from)
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true })
      cpTree(from, to, undefined)
    } else {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
}

async function stagePayload(distDir) {
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(join(stagingDir, "dist"), { recursive: true })
  mkdirSync(join(stagingDir, "node"), { recursive: true })
  cpTree(distDir, join(stagingDir, "dist"))
  const runtimeDirIn = await ensureNodeRuntime()
  cpTree(runtimeDirIn, join(stagingDir, "node"))
  writeCmdLaunchers()
  const ih = statSync(join(stagingDir, "dist", "ih.mjs"))
  if (ih.size === 0) fail("dist/ih.mjs is empty — payload contract broken")
  const nodeExe = statSync(join(stagingDir, "node", "node.exe"))
  if (nodeExe.size < 30e6) fail(`staged node.exe is suspiciously small (${nodeExe.size} bytes) — bad runtime cache`)
  console.log(`staging ready: dist/ (payload incl. dist/ih.mjs) + node/ (runtime ${(nodeExe.size / 1e6).toFixed(1)} MB exe) + *.cmd launchers`)
}

// -- 4. makensis -------------------------------------------------------------

async function locateMakensis() {
  if (process.env.IH_MAKENSIS && existsSync(process.env.IH_MAKENSIS)) {
    console.log(`using makensis: ${process.env.IH_MAKENSIS} (IH_MAKENSIS)`)
    return process.env.IH_MAKENSIS
  }
  const local = join(toolsDir, "makensis", "makensis.exe")
  const localComplete = existsSync(local) && existsSync(join(toolsDir, "makensis", "Stubs"))
  if (localComplete) {
    console.log(`using makensis: ${relative(repoRoot, local)} (cached)`)
    return local
  }
  if (existsSync(local)) {
    // stale partial flatten (e.g. from an interrupted earlier build)
    rmSync(join(toolsDir, "makensis"), { recursive: true, force: true })
  }
  // PATH lookup
  const where = spawnSync("where.exe", ["makensis.exe"], { encoding: "utf8" })
  if (where.status === 0 && where.stdout.trim()) {
    const hit = where.stdout.trim().split(/\r?\n/)[0]
    console.log(`using makensis from PATH: ${hit}`)
    return hit
  }
  console.log(`no makensis on PATH or build/tools — downloading portable NSIS ${NSIS_VERSION}`)
  console.log(`  ${NSIS_ZIP_URL}`)
  const zipPath = join(downloadsDir, `nsis-${NSIS_VERSION}.zip`)
  await download(NSIS_ZIP_URL, zipPath, `nsis-${NSIS_VERSION}.zip`)
  const extractDir = join(toolsDir, `nsis-${NSIS_VERSION}`)
  await extractZip(zipPath, extractDir)
  const found = findFiles(extractDir, (p) => basename(p) === "makensis.exe")
  if (found.length === 0) fail(`downloaded NSIS zip did not contain makensis.exe — corrupt download? ${zipPath}`)
  // The portable zip nests makensis.exe in Bin/ (first find) while Stubs/,
  // Include/ and Plugins/ sit at the script root — prefer that root.
  const nsisRoot =
    found.map(dirname).find((d) => existsSync(join(d, "Stubs")) && existsSync(join(d, "Include"))) ??
    dirname(found[0])
  // flatten so the wrapper path is stable regardless of zip root folder name
  mkdirSync(join(toolsDir, "makensis"), { recursive: true })
  cpTree(nsisRoot, join(toolsDir, "makensis"))
  if (!existsSync(local) || !existsSync(join(toolsDir, "makensis", "Stubs"))) {
    fail(`flattening NSIS failed: ${local} (Stubs/ missing) — bad portable zip?`)
  }
  console.log(`makensis staged: ${relative(repoRoot, local)}`)
  return local
}

async function compile(makensis, testMode) {
  const args = ["/DAPP_VERSION=" + APP_VERSION]
  if (testMode) args.push("/DIH_NSIS_TEST")
  args.push(join(repoRoot, "installer", "ih.nsi"))
  console.log(`\n  makensis ${args.join(" ")}`)
  const res = await runAsync(makensis, args)
  console.log(res.out)
  if (res.code !== 0) {
    fail(`makensis ${testMode ? "(test build) " : ""}failed — exit ${res.code}. ` +
      `(If the portable zip was used: it must be a full NSIS distribution with Include/ + Plugins/. URL: ${NSIS_ZIP_URL})`)
  }
  return testMode ? `build\\I-harness-Setup-${APP_VERSION}-test.exe` : `build\\I-harness-Setup-${APP_VERSION}.exe`
}

// -- main --------------------------------------------------------------------

async function main() {
  console.log(`build-installer v${APP_VERSION} — NSIS ${NSIS_VERSION} setup + node ${NODE_RUNTIME_VERSION} runtime`)
  const distDir = await step("Step 1/4  payload (dist)", () => ensureDist())
  await step("Step 3/4  staging (payload + runtime + launchers)", () => stagePayload(distDir))
  const makensis = await step("Step 4/4  NSIS toolchain", () => locateMakensis())
  const normalExe = await compile(makensis, false)
  const testExe = await compile(makensis, true)
  console.log(`\n=== DONE ===`)
  for (const rel of [normalExe, testExe]) {
    const abs = join(repoRoot, rel)
    console.log(`  ${rel}  (${(statSync(abs).size / 1e6).toFixed(2)} MB)`)
  }
}

main().catch((e) => {
  console.error("[build-installer] ERROR:", e.message)
  process.exit(1)
})
