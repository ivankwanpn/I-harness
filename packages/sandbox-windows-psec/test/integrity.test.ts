import { expect, it } from "vitest"
import { basename, dirname, resolve } from "node:path"
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { verifyHelper } from "../src/integrity.ts"
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const packageRoot = resolve(repo, "packages/sandbox-windows-psec")
const runnerModules = ["prepared", "running", "control", "status", "event_drain", "dispatch"].map(name => `native/src/runner/${name}.rs`)

function assertSourceCoverage(root: string) {
  const manifest = JSON.parse(readFileSync(resolve(root, "artifacts/win32-x64/manifest.json"), "utf8"))
  const rustSources = readdirSync(resolve(root, "native/src"), { recursive: true })
    .map(String).filter(file => file.endsWith(".rs")).map(file => `native/src/${file.replaceAll("\\", "/")}`)
  expect(rustSources).toEqual(expect.arrayContaining(runnerModules))
  expect(Object.keys(manifest.sources).filter(file => file.endsWith(".rs")).sort()).toEqual(rustSources.sort())
}

it("pins every Rust source including the private runner modules", () => assertSourceCoverage(packageRoot))

it.each(runnerModules)("rejects a changed nested source %s in asset provenance", file => {
  const fixture = mkdtempSync(resolve(repo, ".tmp/sandbox-redesign-source-integrity-"))
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "artifacts/win32-x64/manifest.json"), "utf8"))
  cpSync(resolve(packageRoot, "artifacts"), resolve(fixture, "artifacts"), { recursive: true })
  for (const path of ["protocol.md", "qualification.json", ...Object.keys(manifest.sources)]) {
    mkdirSync(dirname(resolve(fixture, path)), { recursive: true })
    copyFileSync(resolve(packageRoot, path), resolve(fixture, path))
  }
  const checker = pathToFileURL(resolve(repo, "scripts/runtime-native-assets.mjs")).href
  const check = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {verifyNativeAssets} from ${JSON.stringify(checker)}; verifyNativeAssets(${JSON.stringify(fixture)}, {sources:true})`],
    { encoding: "utf8", windowsHide: true })
  expect(check().status).toBe(0)
  expect(manifest.sources[file]).toMatch(/^[0-9a-f]{64}$/)
  appendFileSync(resolve(fixture, file), "\n// owned mutation proof\n")
  const rejected = check()
  expect(rejected.status).not.toBe(0)
  expect(rejected.stderr).toContain(`Stale native helper source: ${file}`)
  // Exercise the same independent coverage gate on the omitted manifest entry.
  delete manifest.sources[file]
  writeFileSync(resolve(fixture, "artifacts/win32-x64/manifest.json"), JSON.stringify(manifest))
  expect(() => assertSourceCoverage(fixture)).toThrow()
})

it("rejects an executable whose content differs from the pinned manifest", async () => {
  const source = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64")
  const fixture = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-integrity-"))
  const manifestPath = resolve(fixture, "manifest.json")
  const helperPath = resolve(fixture, "i-harness-windows-helper.exe")
  copyFileSync(resolve(source, basename(helperPath)), helperPath)
  copyFileSync(resolve(source, "manifest.json"), manifestPath)
  appendFileSync(helperPath, Buffer.from([0]))
  await expect(verifyHelper({ helperPath, manifestPath })).rejects.toThrow(/hash mismatch/i)
})

it("requires manifest and helper in the same artifact directory", async () => {
  const fixture = mkdtempSync(resolve(repo, ".tmp", "sandbox-redesign-location-"))
  const manifestPath = resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/manifest.json")
  const helperPath = resolve(fixture, "i-harness-windows-helper.exe")
  copyFileSync(resolve(repo, "packages/sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe"), helperPath)
  await expect(verifyHelper({ helperPath, manifestPath })).rejects.toThrow(/location/i)
})
