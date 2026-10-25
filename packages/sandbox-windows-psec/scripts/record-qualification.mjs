import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { release } from "node:os"

// Derive an experimental observation record, never an acceptance certificate.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [input, output] = process.argv.slice(2)
assert(input && output, "usage: node scripts/record-qualification.mjs <raw-results.json> <output.json>")
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const read = path => readFileSync(path)
const raw = read(resolve(input))
const evidence = JSON.parse(raw)
const manifest = JSON.parse(read(resolve(root, "artifacts/win32-x64/manifest.json")))
const asset = name => resolve(root, "artifacts/win32-x64", name)
assert.equal(process.platform, "win32")
assert.equal(evidence.platform, "win32")
assert.equal(realpathSync(evidence.packageRoot), realpathSync(root))
assert.equal(realpathSync(evidence.helper), realpathSync(asset(manifest.helperFile)))
assert.deepEqual(evidence.manifest, manifest, "raw observations must bind this exact manifest")
assert.equal(evidence.helperSha256, manifest.helperSha256)
assert.equal(sha(read(asset(manifest.helperFile))), manifest.helperSha256)
assert.equal(sha(read(asset(manifest.msysPty.file))), manifest.msysPty.sha256)
assert.equal(sha(read(resolve(root, "protocol.md"))), manifest.protocolSha256)
assert.equal(evidence.windowsRelease, release())
assert.equal(evidence.protectedUnchanged, true)
for (const [file, expected] of Object.entries(manifest.sources)) {
  assert(!file.includes("..") && !file.includes(":"), "source path must stay package-relative")
  assert.equal(sha(read(resolve(root, file))), expected, `stale native source: ${file}`)
}
const rust = readdirSync(resolve(root, "native/src"), { recursive: true }).map(String)
  .filter(file => file.endsWith(".rs")).map(file => `native/src/${file.replaceAll("\\", "/")}`).sort()
assert.deepEqual(Object.keys(manifest.sources).filter(file => file.endsWith(".rs")).sort(), rust)
const expected = new Map([
  ["helper-integrity-and-probe", "pass"],
  ["psec-filesystem-workspace-write", "pass"],
  ["psec-filesystem-read-only", "pass"],
  ["psec-junction-alias-reference", "pass"],
  ["unrestricted-refuses-reference-lock", "pass"],
  ["unrestricted-refuses-deny-lock", "pass"],
  ["psec-missing-LOCALAPPDATA-203", "pass"],
  ["unrestricted-node-exact-argv-cwd-env", "pass"],
  ["unrestricted-node-binary-pipes", "pass"],
  ["unrestricted-full-width-exit", "pass"],
  ["unrestricted-native-pipe-input", "pass"],
  ["unrestricted-tsx-pipe", "pass"],
  ["unrestricted-retain-descendant", "pass"],
  ["unrestricted-job-cancel-timeout", "pass"],
  ["unrestricted-job-cancel-descendant", "pass"],
  ["unrestricted-output-cancel-accounting", "pass"],
  ["unrestricted-cmd", "pass"],
  ["unrestricted-powershell", "pass"],
  ["unrestricted-git", "pass"],
  ["unrestricted-msys-bash-pipe", "pass"],
  ["psec-node-exact-argv-cwd-env", "pass"],
  ["psec-node-binary-pipes", "pass"],
  ["psec-full-width-exit", "pass"],
  ["psec-native-pipe-input", "pass"],
  ["psec-tsx-pipe", "pass"],
  ["psec-retain-descendant", "pass"],
  ["psec-job-cancel-timeout", "pass"],
  ["psec-job-cancel-descendant", "pass"],
  ["psec-output-cancel-accounting", "pass"],
  ["psec-cmd", "pass"],
  ["psec-powershell", "pass"],
  ["psec-git", "pass"],
  ["psec-msys-bash-pipe", "unsupported"],
  ["psec-msys-matrix-launcher-retain-tree", "unsupported"],
  ["psec-msys-matrix-direct-complete-tree", "unsupported"],
  ["psec-msys-matrix-direct-retain-tree", "unsupported"],
  ["psec-pty-rejected-before-workload", "pass"],
  ["unrestricted-pty-input-resize", "pass"],
  ["unrestricted-pty-retain-descendant", "pass"],
  ["unrestricted-msys-pty-absolute-runtime-input-resize", "pass"],
  ["host-loopback-positive", "pass"],
  ["psec-loopback-egress-denial", "pass"],
  ["protected-reference-content-metadata-acl", "pass"],
])
const rows = new Map()
for (const row of evidence.results) {
  assert(!rows.has(row.name), `duplicate observation: ${row.name}`)
  assert(expected.has(row.name), `unknown standard observation: ${row.name}`)
  assert.equal(row.outcome, expected.get(row.name), `unexpected standard outcome: ${row.name}`)
  rows.set(row.name, row.outcome)
}
for (const name of expected.keys()) assert(rows.has(name), `missing required observation: ${name}`)
const observed = { passed: [...rows.values()].filter(v => v === "pass").length, failed: 0,
  unsupported: [...rows.values()].filter(v => v === "unsupported").length }
assert.deepEqual(observed, { passed: 39, failed: 0, unsupported: 4 }, "this owner records the original standard matrix only")
const pair = (psec, unrestricted) => ({ psec, unrestricted })
const record = {
  recordVersion: 1, helperSha256: manifest.helperSha256, protocolSha256: manifest.protocolSha256,
  windowsRelease: evidence.windowsRelease, observationScope: "historical-one-host",
  applicabilityInputs: ["windows-release", "helper-sha256", "protocol-sha256"], assurance: "experimental",
  result: "incomplete", observed,
  sourceFamilies: {
    gitMsysBash: pair("unsupported", "observed-pass"), nodeAndTsxPipes: pair("observed-pass", "observed-pass"),
    cmdAndPowerShellPipes: pair("observed-pass", "observed-pass"), conPty: pair("unsupported", "observed-pass"),
    msysPty: pair("unsupported", "observed-pass"),
  },
  observedAt: evidence.generatedAt, msysPtyTemplateSha256: manifest.msysPty.sha256,
  evidence: { sha256: sha(raw), scope: "original-standard-control-matrix",
    limits: ["One historical host; no current installed-runtime or policy certification.",
      "Advanced MSYS external-program TTY/proc compatibility and event-owner pathological/fault gates remain separate; this standard matrix does not qualify them.",
      "PSEC MSYS routes remain unsupported; PSEC PTY remains refused."] },
}
assert(Number.isFinite(Date.parse(record.observedAt)))
writeFileSync(resolve(output), JSON.stringify(record, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ output: resolve(output), observed, helperSha256: record.helperSha256,
  templateSha256: record.msysPtyTemplateSha256, evidenceSha256: record.evidence.sha256, result: record.result }))
