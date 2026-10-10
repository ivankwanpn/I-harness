#!/usr/bin/env node
import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { buildInstaller, testMarker, testOwner, validatePayload } from "../scripts/build-installer.mjs"
import { createInstallerFixture } from "./installer-fixture.mjs"

const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const source = option("--app-dir"), nsis = option("--nsis")
assert(source && nsis, "safety test requires --app-dir and --nsis")
const { appName } = validatePayload(source)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const token = randomUUID()
const root = join(repo, ".tmp", `desktop-installer-safety-${token}`)
const evidence = join(repo, ".superpowers", "sdd", "2026-10-04-desktop-installer")
mkdirSync(root, { recursive: true }); mkdirSync(evidence, { recursive: true })
writeFileSync(join(root, testMarker), `[Test]\nOwner=${testOwner}\nToken=${token}\n`)
const old = buildInstaller({ appDir: createInstallerFixture(source, join(root, "old-payload")), nsis, outDir: join(root, "old-setup"), testRoot: root })
const current = buildInstaller({ appDir: createInstallerFixture(source, join(root, "new-payload"), "new"), nsis, outDir: join(root, "new-setup"), testRoot: root })
const results = [], ownedPids = []
const controls = values => writeFileSync(join(root, "test-controls.ini"), `[Controls]\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`)
controls({})
function run(executable, parameters) {
  const result = spawnSync(executable, parameters, { cwd: root, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
  if (result.pid) ownedPids.push(result.pid)
  if (result.error) throw result.error
  return result
}
const install = (setup, target) => run(setup, ["/S", `/D=${target}`])
const target = name => join(root, name, "I-harness Desktop")
function uninstaller(target, name) {
  const copy = join(root, `${name}-uninstall.exe`)
  copyFileSync(join(target, "Uninstall.exe"), copy)
  return copy
}
async function ready(path) {
  for (let retry = 0; retry < 200 && !existsSync(path); retry++) await new Promise(done => setTimeout(done, 50))
  assert(existsSync(path), `test process did not become ready: ${path}`)
}
async function lockFile(path) {
  const id = randomUUID(), signal = join(root, `lock-${id}.ready`), release = join(root, `lock-${id}.release`)
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", "$installerLockStream = [IO.File]::Open($env:IH_INSTALLER_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [IO.File]::WriteAllText($env:IH_INSTALLER_LOCK_READY, 'ready'); while (-not [IO.File]::Exists($env:IH_INSTALLER_LOCK_RELEASE)) { Start-Sleep -Milliseconds 50 }; $installerLockStream.Dispose()"], {
    env: { ...process.env, IH_INSTALLER_LOCK_FILE: path, IH_INSTALLER_LOCK_READY: signal, IH_INSTALLER_LOCK_RELEASE: release }, stdio: "ignore", windowsHide: true,
  })
  ownedPids.push(child.pid)
  const exited = new Promise(done => child.once("exit", done))
  await ready(signal)
  return async () => { writeFileSync(release, "release"); await exited }
}
async function check(name, body) {
  await test(name, async () => {
    try { await body(); results.push({ name, status: "passed" }) }
    catch (error) { results.push({ name, status: "failed", error: error.message }); throw error }
    finally { controls({}) }
  })
}

await check("a retained uninstaller refuses a different newer payload at the same version", () => {
  const location = target("stale")
  assert.equal(install(old.output, location).status, 0)
  const stale = uninstaller(location, "stale")
  assert.equal(install(current.output, location).status, 0)
  assert.notEqual(run(stale, ["/S", `_?=${location}`]).status, 0)
  assert(existsSync(join(location, ".i-harness-desktop-install.ini")))
  assert(existsSync(join(location, "resources/gateway/current-only.txt")))
})

await check("a locked recovery uninstaller keeps ownership and can be retried after unlocking", async () => {
  const location = target("locked-uninstaller")
  assert.equal(install(old.output, location).status, 0)
  const copy = uninstaller(location, "locked")
  writeFileSync(join(location, "keep-user-file.txt"), "keep")
  const release = await lockFile(join(location, "Uninstall.exe"))
  try {
    assert.notEqual(run(copy, ["/S", `_?=${location}`]).status, 0)
    assert(existsSync(join(location, ".i-harness-desktop-install.ini")))
    assert(existsSync(join(location, "Uninstall.exe")))
  } finally { await release() }
  assert.equal(run(copy, ["/S", `_?=${location}`]).status, 0)
  assert(!existsSync(join(location, ".i-harness-desktop-install.ini")))
  assert.equal(readFileSync(join(location, "keep-user-file.txt"), "utf8"), "keep")
})

for (const [name, control] of [["marker", "FailMarkerBootstrap"], ["uninstaller", "FailUninstallerBootstrap"]]) {
  await check(`failed ${name} bootstrap aborts before copying the application payload`, () => {
    const location = target(`bootstrap-${name}`)
    controls({ [control]: 1 })
    assert.notEqual(install(old.output, location).status, 0)
    assert(!existsSync(join(location, appName + '.exe')))
    assert(!existsSync(join(location, "resources/app/out/main/index.js")))
  })
}

await check("a second Setup refuses an operation held by the first Setup before payload mutation", async () => {
  const location = target("overlap")
  controls({ HoldFirstSetup: 1 })
  const first = spawn(old.output, ["/S", `/D=${location}`], { cwd: root, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
  ownedPids.push(first.pid)
  const exited = new Promise(done => first.once("exit", done))
  try {
    await ready(join(root, "setup-ready.txt"))
    assert(!existsSync(join(location, appName + '.exe')))
    assert.notEqual(install(old.output, location).status, 0)
    assert(!existsSync(join(location, appName + '.exe')))
  } finally { controls({}); await exited }
  assert(existsSync(join(location, appName + '.exe')))
})

writeFileSync(join(evidence, `safety-${token}.json`), `${JSON.stringify({ root, old, current, results, ownedPids, finishedAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`Safety evidence: ${join(evidence, `safety-${token}.json`)}`)
