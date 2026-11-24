#!/usr/bin/env node
// Uses two full, isolated NSIS setups built in the same owned test namespace.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { validateTestRoot, testOwner } from "../scripts/build-installer.mjs"

const { values } = parseArgs({ options: { root: { type: "string" }, previous: { type: "string" }, candidate: { type: "string" } } })
assert.equal(process.platform, "win32")
assert(values.root && values.previous && values.candidate, "Specify --root, --previous and --candidate")
const { testRoot: root, token } = validateTestRoot(values.root)
const json = path => JSON.parse(readFileSync(path, "utf8"))
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex")
function setup(input, version) {
  assert(isAbsolute(input))
  const path = resolve(input), tail = relative(root, path)
  assert(tail && !tail.startsWith(".." + sep) && tail !== ".." && !isAbsolute(tail))
  assert.equal(lstatSync(path).isFile(), true)
  const build = json(path.replace(/\.exe$/i, ".installer-build.json"))
  assert.equal(build.output, path)
  assert.equal(build.version, version)
  assert.equal(build.isolatedTest, true)
  assert.equal(build.sha256, hash(path))
  return build
}
const previous = setup(values.previous, "0.1.16"), candidate = setup(values.candidate, "0.1.17")
const installed = join(root, "I-harness")
const app = join(installed, "I-harness.exe")
const owner = join(installed, ".i-harness-desktop-install.ini")
assert(!existsSync(installed), "Use a clean destination inside the owned test namespace")
const seeds = join(root, "legacy-profile")
const workspace = join(root, "workspace")
mkdirSync(seeds); mkdirSync(workspace)
const keep = join(installed, "unrelated.txt")
const prefs = join(seeds, "preferences.json")
const attachments = join(seeds, "attachments")
mkdirSync(attachments)
writeFileSync(prefs, JSON.stringify({ theme: "dark", approvedFixturePreference: true }))
writeFileSync(join(attachments, "example.txt"), "attached before upgrade")
const profiles = [prefs, join(attachments, "example.txt")]
const probe = join(root, "profile-probe.mjs")
writeFileSync(probe, `
  import assert from "node:assert/strict"
  import { writeFileSync } from "node:fs"
  import { join } from "node:path"
  import { pathToFileURL } from "node:url"
  const { IH_UPGRADE_INSTALL: root, IH_UPGRADE_PROFILE: profile, IH_UPGRADE_WORKSPACE: workspace } = process.env
  const spec = pathToFileURL(join(root, "resources/gateway/cli/src/host.js"))
  const { createDesktopHost } = await import(spec)
  const frames = []
  const settingsPath = join(profile, "settings.json")
  if (process.argv[2] === "seed") writeFileSync(settingsPath, JSON.stringify({ sandboxMode: "read-only", autoTitle: false, sessionStore: "jsonl" }))
  const host = await createDesktopHost({
    workspace, sessionDir: join(profile, "sessions"), settingsPath,
    credentialsPath: join(profile, "credentials.json"), onWrite: value => frames.push(value),
  })
  let id = 0
  const call = async (method, params = {}) => {
    const requestId = ++id
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    const reply = frames.find(frame => frame.id === requestId)
    assert(reply && "result" in reply, method + " failed to return a result")
    return reply.result
  }
  try {
    await call("initialize")
    if (process.argv[2] === "seed") {
      console.log(JSON.stringify(await call("session/create")))
    } else {
      const id = process.env.IH_UPGRADE_SESSION
      const rows = await call("session/dashboard")
      assert(rows.sessions.some(session => session.id === id))
      const history = await call("session/history", { sessionId: id, afterSeq: 0 })
      assert(history.events.some(event => event.type === "user/message" && event.text === "before update"))
      console.log(JSON.stringify({ restored: id, events: history.events.length, node: process.versions.node }))
    }
  } finally { await host.close() }
`)
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8", timeout: 240000, windowsHide: true, windowsVerbatimArguments: true, ...options })
  if (result.error) throw result.error
  return result
}
const install = build => run(build.output, ["/S", "/D=" + installed])
function assertOwner() {
  const marker = readFileSync(owner, "utf8")
  assert(marker.includes("Owner=" + testOwner + "." + token) && marker.includes("Path=" + installed))
}
function uninstall() {
  assertOwner()
  const copy = join(root, "verified-uninstall.exe")
  copyFileSync(join(installed, "Uninstall.exe"), copy)
  assert.equal(run(copy, ["/S", "_?=" + installed]).status, 0)
  assert(!existsSync(app))
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", IH_UPGRADE_INSTALL: installed, IH_UPGRADE_PROFILE: seeds, IH_UPGRADE_WORKSPACE: workspace }
delete env.NODE_OPTIONS
delete env.NODE_PATH
delete env.IH_CONFIG_DIR
function profile(mode) {
  const result = run(app, [probe, mode], { env, windowsVerbatimArguments: false })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

assert.equal(install(previous).status, 0)
assertOwner()
assert.equal(hash(app), previous.payloadExeSha256)
writeFileSync(keep, "unowned installation folder file")
const created = profile("seed")
assert(typeof created.sessionId === "string")
env.IH_UPGRADE_SESSION = created.sessionId
const installedBackend = join(installed, "resources/gateway/node_modules/@i-harness")
const importPackaged = relativePath => import(pathToFileURL(join(installedBackend, relativePath)))
const { createSessionCoordinator } = await importPackaged("session-persistence/src/index.js")
const { createJsonlBackend } = await importPackaged("session-persistence-jsonl/src/index.js")
const sessions = join(seeds, "sessions")
const writer = createSessionCoordinator(createJsonlBackend(sessions), { lock: { enabled: true, lockRoot: sessions } })
try {
  await writer.append(created.sessionId, [
    { type: "turn/start" }, { type: "user/message", text: "before update" },
    { type: "assistant/message", text: "retained reply" }, { type: "turn/end" },
  ])
} finally { await writer.close() }
const original = profile("verify"), digests = profiles.map(hash)
const runningMarker = join(root, "running-ready")
const running = spawn(app, ["-e", "require('node:fs').writeFileSync(process.env.IH_UPGRADE_RUNNING, 'ready');setInterval(()=>{},1000)"], {
  env: { ...env, IH_UPGRADE_RUNNING: runningMarker }, windowsHide: true, stdio: "ignore",
})
const exited = once(running, "exit")
try {
  for (let ticks = 0; !existsSync(runningMarker) && ticks < 100; ticks++) await delay(100)
  assert(existsSync(runningMarker), "Previous executable must be running")
  assert.notEqual(install(candidate).status, 0, "Active app must prevent update")
  assert.equal(hash(app), previous.payloadExeSha256)
} finally { if (running.exitCode === null) running.kill(); await exited }

const control = join(root, "test-controls.ini")
writeFileSync(control, "[Controls]\nFailPayloadCopy=1\n")
try { assert.notEqual(install(candidate).status, 0, "Fault-injected payload copy must fail") }
finally { writeFileSync(control, "[Controls]\nFailPayloadCopy=0\n") }
const obstruction = join(installed, "resources/app/out/main/index.js")
assert(lstatSync(obstruction).isDirectory(), "Test hook must interrupt a real payload file")
rmdirSync(obstruction)
uninstall()
assert.deepEqual(profiles.map(hash), digests)
assert.equal(install(previous).status, 0, "Previous version must be restorable")
assert.equal(profile("verify").restored, original.restored)
assert.equal(install(candidate).status, 0, "Idle installation must upgrade to the candidate")
assert.equal(hash(app), candidate.payloadExeSha256)
const upgraded = profile("verify")
assert.equal(upgraded.events, original.events)
assert.deepEqual(profiles.map(hash), digests)
uninstall()
assert.equal(readFileSync(keep, "utf8"), "unowned installation folder file")
assert.deepEqual(profiles.map(hash), digests)
const receipt = { previous: previous.version, candidate: candidate.version, versions: [previous.payloadId, candidate.payloadId],
  runningProtection: true, copyInterrupted: true, restoredPrevious: true, upgraded: true, retainedEvents: upgraded.events,
  preservedProfile: true, removedOwnedPayload: true }
writeFileSync(join(root, "version-upgrade.json"), JSON.stringify(receipt, null, 2) + "\n")
console.log(JSON.stringify(receipt, null, 2))
