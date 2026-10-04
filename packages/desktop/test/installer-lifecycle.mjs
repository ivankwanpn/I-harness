#!/usr/bin/env node
// Explicit Windows integration test. It compiles a file-only installer namespace
// and never creates the current user's shortcuts or uninstall registry entry.
import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { buildInstaller, testMarker, testOwner, validatePayload, validateTestRoot } from "../scripts/build-installer.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "..", "..")
const args = process.argv.slice(2)
const appDir = args[args.indexOf("--app-dir") + 1]
const nsis = args[args.indexOf("--nsis") + 1]
const resumeRoot = args.includes("--resume-root") ? args[args.indexOf("--resume-root") + 1] : undefined
assert(appDir && nsis, "usage: node test/installer-lifecycle.mjs --app-dir <absolute payload> --nsis <absolute compiler>")
assert.equal(process.platform, "win32", "the installer lifecycle test requires Windows")
const payload = validatePayload(appDir)
const token = resumeRoot ? validateTestRoot(resumeRoot).token : randomUUID()
const root = join(repoRoot, ".tmp", `desktop-installer-smoke-${token}`)
if (resumeRoot) assert.equal(resolve(resumeRoot), root, "resume root must match its owned smoke token")
const evidenceDir = join(repoRoot, ".superpowers", "sdd", "2026-10-04-desktop-installer")
mkdirSync(root, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })
const markerText = `[Test]\nOwner=${testOwner}\nToken=${token}\n`
writeFileSync(join(root, testMarker), markerText)
const checks = [], processes = []
let running
function record(name, detail = {}) { checks.push({ name, ...detail }); console.log(`PASS ${name}`) }
function run(executable, args, extra = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 45_000, ...extra })
  if (result.error) throw result.error
  return result
}
function install(setup, target) { return run(setup, ["/S", `/D=${target}`]) }
function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex") }
function compileFixture(stage, source) {
  const output = join(root, stage, `I-harness-Desktop-Setup-${payload.version}-test.exe`)
  if (resumeRoot && existsSync(output)) {
    const metadata = JSON.parse(readFileSync(output.replace(/\.exe$/, ".installer-build.json"), "utf8"))
    assert.equal(metadata.output, output)
    assert.equal(metadata.appDir, source)
    assert.equal(metadata.isolatedTest, true)
    assert.equal(metadata.sha256, hash(output), "resumed test installer hash must match the compile record")
    return metadata
  }
  return buildInstaller({ appDir: source, nsis, outDir: join(root, stage), testRoot: root })
}
function put(base, relative, text = "fixture") {
  const path = join(base, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function earlierFixture() {
  const earlier = join(root, "earlier-payload", "I-harness Desktop")
  for (const file of [
    "chrome_100_percent.pak", "chrome_200_percent.pak", "d3dcompiler_47.dll", "dxcompiler.dll",
    "dxil.dll", "ffmpeg.dll", "icudtl.dat", "resources.pak", "v8_context_snapshot.bin", "snapshot_blob.bin",
    "vk_swiftshader.dll", "vulkan-1.dll", "LICENSE", "LICENSES.chromium.html", "locales/en-US.pak",
    "resources/app/out/main/index.js", "resources/app/out/preload/index.cjs", "resources/app/out/renderer/index.html",
    "resources/app/out/main/attachment-reader-worker.mjs", "resources/app/out/main/pdf.worker.mjs",
    "resources/app/out/main/cmaps/fixture.bcmap", "resources/app/out/main/standard_fonts/fixture.pfb",
    "resources/app/out/main/wasm/fixture.wasm", "resources/app/out/main/node_modules/@napi-rs/canvas/package.json",
    "resources/app/licenses/opencode/LICENSE", "resources/app/licenses/zcode/LICENSE", "resources/gateway/cli/src/cli.ts",
    "resources/gateway/cli/src/host.ts", "resources/gateway/node_modules/tsx/dist/loader.mjs",
    "resources/gateway/obsolete-owned.txt", "resources/app/$literal-owned.txt",
  ]) put(earlier, file)
  for (const file of ["version", "resources/app/package.json", "resources/app/LICENSE", "resources/app/THIRD_PARTY_NOTICES", "resources/gateway/cli/package.json", "resources/gateway/node_modules/tsx/package.json"]) {
    const target = join(earlier, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(appDir, file), target)
  }
  const gateway = JSON.parse(readFileSync(join(appDir, "resources/gateway/cli/package.json"), "utf8"))
  for (const name of Object.keys(gateway.dependencies)) {
    const file = `resources/gateway/node_modules/${name}/package.json`
    const target = join(earlier, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(appDir, file), target)
  }
  copyFileSync(join(process.env.WINDIR, "System32", "whoami.exe"), join(earlier, "I-harness Desktop.exe"))
  return earlier
}

try {
  const installed = join(root, "I-harness Desktop")
  if (resumeRoot && existsSync(join(installed, "Uninstall.exe"))) {
    const marker = readFileSync(join(installed, ".i-harness-desktop-install.ini"), "utf8")
    assert(marker.includes(`Owner=${testOwner}.${token}`) && marker.includes(`Path=${installed}`), "resume cleanup requires the same owned installation")
    const previous = join(root, "resume-uninstall.exe")
    copyFileSync(join(installed, "Uninstall.exe"), previous)
    assert.equal(run(previous, ["/S", `_?=${installed}`]).status, 0, "resume cleanup must remove only the previous owned payload")
    const sentinel = join(installed, "keep-user-file.txt")
    if (existsSync(sentinel)) {
      assert.equal(readFileSync(sentinel, "utf8"), "unrelated install folder content")
      unlinkSync(sentinel)
    }
  }
  let first
  assert.doesNotThrow(() => { first = compileFixture("first-setup", earlierFixture()) }, "the fixture installer must compile")
  record("compile earlier file-only fixture", { metadata: first })
  for (const target of [join(root, "invalid-name"), "D:\\"]) {
    const result = install(first.output, target)
    assert.notEqual(result.status, 0, "unsafe destination must be refused")
    record("refuse unsafe destination", { target, exitCode: result.status })
  }
  const unowned = join(root, "unowned", "I-harness Desktop")
  put(unowned, "keep.txt", "unowned directory content")
  assert.notEqual(install(first.output, unowned).status, 0)
  assert.equal(readFileSync(join(unowned, "keep.txt"), "utf8"), "unowned directory content")
  assert(!existsSync(join(unowned, "Uninstall.exe")))
  record("refuse nonempty unowned destination")

  assert.equal(install(first.output, installed).status, 0, `fresh owned test install must succeed: ${existsSync(join(root, "last-failure.txt")) ? readFileSync(join(root, "last-failure.txt"), "utf8") : "no diagnostic"}`)
  assert(existsSync(join(installed, "resources/gateway/obsolete-owned.txt")))
  assert(existsSync(join(installed, "resources/app/$literal-owned.txt")))
  assert(existsSync(join(root, "shortcuts", "desktop", "I-harness Desktop.lnk")))
  assert(existsSync(join(root, "shortcuts", "start-menu", "I-harness Desktop.lnk")))
  record("fresh install creates payload, uninstaller and isolated shortcuts")
  put(installed, "keep-user-file.txt", "unrelated install folder content")
  put(root, "user-data/session.json", "persistent user data sentinel")
  const current = compileFixture("current-setup", appDir)
  record("compile complete file-only payload", { metadata: current })
  assert.equal(install(current.output, installed).status, 0, "owned upgrade must succeed")
  assert(!existsSync(join(installed, "resources/gateway/obsolete-owned.txt")), "old gateway payload must be removed")
  assert(!existsSync(join(installed, "resources/app/$literal-owned.txt")), "escaped old app payload must be removed")
  assert.equal(readFileSync(join(installed, "keep-user-file.txt"), "utf8"), "unrelated install folder content")
  record("upgrade removes obsolete owned files and preserves unrelated content")

  const executable = join(installed, "I-harness Desktop.exe")
  const nodeProbe = join(root, "backend-probe.mjs")
  writeFileSync(nodeProbe, `import { pathToFileURL } from "node:url"; import assert from "node:assert/strict"; import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const appDir = process.env.IH_INSTALLER_APP_DIR; const root = process.env.IH_INSTALLER_TEST_ROOT;
const { createDesktopHost } = await import(pathToFileURL(join(appDir, "resources/gateway/cli/src/host.ts")).href);
assert.equal(typeof createDesktopHost, "function"); const frames = []; const workspace = join(root, "backend-workspace"); mkdirSync(workspace, { recursive: true });
const settingsPath = join(root, "backend-settings.json"); writeFileSync(settingsPath, JSON.stringify({ sandboxMode: "read-only", autoTitle: false }));
const host = await createDesktopHost({ workspace, sessionDir: join(root, "backend-sessions"), settingsPath, credentialsPath: join(root, "backend-credentials.json"), onWrite: frame => frames.push(frame) });
try { await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })); assert(frames.some(frame => frame.id === 1 && frame.result)); console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, backendImported: true, initialized: true })); } finally { await host.close(); }
`)
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", IH_INSTALLER_APP_DIR: installed, IH_INSTALLER_TEST_ROOT: root }
  const nodeResult = run(executable, ["--import", pathToFileURL(join(installed, "resources/gateway/node_modules/tsx/dist/loader.mjs")).href, nodeProbe], { env: childEnv, windowsVerbatimArguments: false })
  assert.equal(nodeResult.status, 0, nodeResult.stderr)
  record("installed Electron runs shipped backend and initializes an isolated host", { output: nodeResult.stdout.trim() })

  const runningMarker = join(root, "running-node.json")
  running = spawn(executable, ["--eval", "require('node:fs').writeFileSync(process.env.IH_INSTALLER_RUNNING_MARKER, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)"], { env: { ...childEnv, IH_INSTALLER_RUNNING_MARKER: runningMarker }, stdio: "ignore", windowsHide: true })
  processes.push(running.pid)
  for (let retry = 0; retry < 100 && !existsSync(runningMarker); retry++) await new Promise(done => setTimeout(done, 100))
  assert(existsSync(runningMarker), "owned running Electron probe must become ready")
  const before = hash(executable)
  assert.notEqual(install(current.output, installed).status, 0, "upgrade must refuse a running Desktop executable")
  assert.equal(hash(executable), before)
  const uninstallerCopy = join(root, "uninstall-probe.exe")
  copyFileSync(join(installed, "Uninstall.exe"), uninstallerCopy)
  assert.notEqual(run(uninstallerCopy, ["/S", `_?=${installed}`]).status, 0, "uninstall must refuse a running Desktop executable")
  assert.equal(hash(executable), before)
  record("running app blocks upgrade and uninstall without deleting its executable")
  running.kill()
  await new Promise(done => running.once("exit", done))
  running = null
  assert.equal(run(uninstallerCopy, ["/S", `_?=${installed}`]).status, 0, "idle owned uninstall must succeed")
  assert(!existsSync(executable))
  assert(!existsSync(join(installed, "Uninstall.exe")))
  assert(!existsSync(join(installed, ".i-harness-desktop-install.ini")))
  assert(!existsSync(join(root, "shortcuts", "desktop", "I-harness Desktop.lnk")))
  assert(!existsSync(join(root, "shortcuts", "start-menu", "I-harness Desktop.lnk")))
  assert.equal(readFileSync(join(installed, "keep-user-file.txt"), "utf8"), "unrelated install folder content")
  assert.equal(readFileSync(join(root, "user-data/session.json"), "utf8"), "persistent user data sentinel")
  record("uninstall removes owned payload and shortcuts while preserving user files and app data")
  const processCheck = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:IH_INSTALLER_APP_DIR + '\\I-harness Desktop.exe' }); $items.Count"], { env: childEnv, encoding: "utf8", windowsHide: true })
  assert.equal(processCheck.status, 0, processCheck.stderr)
  assert.equal(Number(processCheck.stdout.trim()), 0, "owned installed app processes must be idle")
  record("all owned installed application processes are idle", { processes })
  const report = { status: "passed", root, source: payload.appDir, checks, processes, completedAt: new Date().toISOString() }
  writeFileSync(join(evidenceDir, `lifecycle-${token}.json`), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ status: report.status, checks: checks.length, evidence: join(evidenceDir, `lifecycle-${token}.json`), root }, null, 2))
} catch (error) {
  if (running) { running.kill(); await new Promise(done => running.once("exit", done)) }
  writeFileSync(join(evidenceDir, `lifecycle-${token}.json`), `${JSON.stringify({ status: "failed", root, checks, processes, error: error.stack }, null, 2)}\n`)
  console.error(error.stack)
  process.exitCode = 1
}
