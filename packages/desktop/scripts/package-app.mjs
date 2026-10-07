#!/usr/bin/env node
// Build a runnable, unsigned portable distribution without extra build tooling:
//   release/I-harness Desktop/               unpacked app (exe + resources/app + resources/gateway)
//   release/I-harness-Desktop-<version>.zip  the same folder, zipped
//
// Usage: node scripts/package-app.mjs; IH_DESKTOP_RELEASE_LABEL selects a
// sibling release folder when an earlier portable app is still open.
// Assumes `electron-vite build` and `scripts/build-gateway.mjs` already ran.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { verifyNativeAssets } from "../../../scripts/runtime-native-assets.mjs"
import { copyRuntimePackage, runtimePackageRoot } from "./runtime-copy.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const outDir = join(packageRoot, "out")
const gatewayDir = join(packageRoot, ".gateway-dist")
const releaseLabel = process.env.IH_DESKTOP_RELEASE_LABEL ?? "release"
if (!/^release(?:-[a-z0-9-]+)?$/.test(releaseLabel)) throw new Error("invalid release folder label")
const releaseDir = resolve(packageRoot, releaseLabel)
if (dirname(releaseDir) !== packageRoot) throw new Error("release folder escaped the Desktop package")
const appName = "I-harness Desktop"
const appDir = join(releaseDir, appName)

for (const required of [outDir, gatewayDir, ...["attachment-reader-worker.mjs", "pdf.worker.mjs", "cmaps", "standard_fonts", "wasm", "node_modules/@napi-rs/canvas"].map((part) => join(outDir, "main", part))]) {
  if (!existsSync(required)) throw new Error(`missing ${required} — run the build steps first`)
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
verifyNativeAssets(join(gatewayDir, "node_modules/@i-harness/sandbox-windows-psec"))
const electronDist = dirname(createRequire(join(packageRoot, "package.json"))("electron"))
const electronExe = join(electronDist, "electron.exe")
if (!existsSync(electronExe)) throw new Error(`electron.exe not found at ${electronExe}`)

rmSync(releaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
cpSync(electronDist, appDir, { recursive: true, dereference: true })
renameSync(join(appDir, "electron.exe"), join(appDir, `${appName}.exe`))

const resources = join(appDir, "resources")
cpSync(outDir, join(resources, "app", "out"), { recursive: true, dereference: true })
cpSync(join(packageRoot, "licenses"), join(resources, "app", "licenses"), { recursive: true })
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

const zipPath = join(releaseDir, `I-harness-Desktop-${manifest.version}.zip`)
const zip = spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path (Join-Path '${appDir}' '*') -DestinationPath '${zipPath}' -Force`,
], { stdio: "inherit", windowsHide: true })
if (zip.status !== 0) throw new Error("Compress-Archive failed")

console.log(`packaged: ${join(appDir, `${appName}.exe`)}`)
console.log(`portable zip: ${zipPath}`)
