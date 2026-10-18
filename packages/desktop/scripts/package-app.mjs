#!/usr/bin/env node
// Build a runnable, unsigned portable distribution without extra build tooling:
//   release/I-harness/                unpacked app (exe + resources/app + resources/gateway)
//   release/I-harness-<version>.zip    the same folder, zipped
//
// Usage: node scripts/package-app.mjs; IH_DESKTOP_RELEASE_LABEL selects a
// sibling release folder when an earlier portable app is still open.
// IH_DESKTOP_GATEWAY_DIR reuses a qualified repository runtime read-only.
// Assumes `electron-vite build` and `scripts/build-gateway.mjs` already ran.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { verifyNativeAssets } from "../../../scripts/runtime-native-assets.mjs"
import { verifyWslAssets } from "../../../scripts/runtime-wsl-assets.mjs"
import { copyRuntimePackage, runtimePackageRoot } from "./runtime-copy.mjs"
import { resolvePackagePaths, validateGatewayRuntime } from "./package-inputs.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const { outDir, gatewayDir, releaseDir, appDir } = resolvePackagePaths(packageRoot)
const appName = "I-harness"
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
validateGatewayRuntime(gatewayDir, manifest.version)

for (const required of [outDir, gatewayDir, ...["attachment-reader-worker.mjs", "pdf.worker.mjs", "cmaps", "standard_fonts", "wasm", "node_modules/@napi-rs/canvas"].map((part) => join(outDir, "main", part))]) {
  if (!existsSync(required)) throw new Error(`missing ${required} — run the build steps first`)
}

verifyNativeAssets(join(gatewayDir, "node_modules/@i-harness/sandbox-windows-psec"))
verifyWslAssets(join(gatewayDir, "node_modules/@i-harness/sandbox-wsl/worker"))
const electronDist = dirname(createRequire(join(packageRoot, "package.json"))("electron"))
const electronExe = join(electronDist, "electron.exe")
if (!existsSync(electronExe)) throw new Error(`electron.exe not found at ${electronExe}`)

rmSync(releaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
cpSync(electronDist, appDir, { recursive: true, dereference: true })
renameSync(join(appDir, "electron.exe"), join(appDir, `${appName}.exe`))

const resources = join(appDir, "resources")
cpSync(outDir, join(resources, "app", "out"), { recursive: true, dereference: true })
cpSync(join(packageRoot, "licenses"), join(resources, "app", "licenses"), { recursive: true })
copyFileSync(join(packageRoot, "src", "renderer", "session", "SLASH_SOURCES.md"), join(resources, "app", "licenses", "ui-controls", "SLASH_SOURCES.md"))
copyFileSync(join(packageRoot, "src", "renderer", "session", "COMPOSER_SOURCES.md"), join(resources, "app", "licenses", "ui-controls", "COMPOSER_SOURCES.md"))
for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
  copyFileSync(join(packageRoot, "..", "..", notice), join(resources, "app", notice))
}
writeFileSync(join(resources, "app", "package.json"), `${JSON.stringify({
  name: manifest.name,
  productName: appName,
  version: manifest.version,
  private: true,
  type: "module",
  main: "./out/main/index.js",
}, null, 2)}\n`)

cpSync(gatewayDir, join(resources, "gateway"), { recursive: true, dereference: true })
// Main-process imports also load Koffi; its loader must retain its package layout.
for (const name of ["koffi", `@koromix/koffi-${process.platform}-${process.arch}`]) {
  copyRuntimePackage(runtimePackageRoot(name, join(gatewayDir, "cli")), join(resources, "app/node_modules", ...name.split("/")))
}

// Powershell quoting: a path is interpolated INTO a single-quoted PS string, so a
// literal `'` in the path would terminate the string and inject the rest. Win32
// paths may contain `'` (they are legal in a file name), so double each one —
// that is PS's own escape inside a single-quoted literal.
const psQuote = (value) => value.replaceAll("'", "''")

const zipPath = join(releaseDir, `I-harness-${manifest.version}.zip`)
// WHY the ErrorActionPreference AND the artifact check below — both are needed:
// Compress-Archive reports failures as Write-Error, which is NON-terminating, so
// the PowerShell process still exits 0. Measured: with a payload file locked by
// a running Desktop/gateway, the archive failed outright (each file reported
// `PermissionDenied` / `CompressArchiveUnauthorizedAccessError`), yet this script
// printed `portable zip: <path>` and exited 0 — a success report for an artifact
// that was never produced. Making errors terminating fixes the exit status; the
// explicit existence/size check is still required because a PARTIAL archive is
// also a wrong artifact (and a stale one from a previous run must not be
// mistaken for this run's output).
const zip = spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path '${psQuote(appDir)}' '*') -DestinationPath '${psQuote(zipPath)}' -Force`,
], { stdio: "inherit", windowsHide: true })
if (zip.status !== 0) throw new Error(`Compress-Archive failed (exit ${zip.status})`)
if (!existsSync(zipPath)) throw new Error(`Compress-Archive reported success but produced no archive: ${zipPath}`)
const zipBytes = statSync(zipPath).size
if (zipBytes === 0) throw new Error(`portable zip is empty (0 bytes): ${zipPath}`)

console.log(`packaged: ${join(appDir, `${appName}.exe`)}`)
console.log(`portable zip: ${zipPath} (${zipBytes} bytes)`)
