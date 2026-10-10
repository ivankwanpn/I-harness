import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyRuntimePackage, runtimePackageRoot } from "../../../packages/desktop/scripts/runtime-copy.mjs"
import { verifyNativeAssets } from "../../runtime-native-assets.mjs"
import { verifyWslAssets } from "../../runtime-wsl-assets.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const args = process.argv.slice(2)
if (args.length !== 3) throw new Error("Usage: node scripts/qualification/wsl-product/package-desktop.mjs BUILD_DIR GATEWAY_DIR FRESH_OUTPUT")
const [build, gateway, out] = args.map(path => resolve(repo, path))
for (const path of [build, gateway, out]) {
  const name = relative(repo, path)
  if (!name || name.startsWith("..") || isAbsolute(name)) throw new Error("All candidate paths must be inside the repository")
}
if (existsSync(out)) throw new Error("Candidate output must be fresh; this script never removes an existing build")
for (const asset of ["main/index.js", "main/attachment-reader-worker.mjs", "main/pdf.worker.mjs", "preload/index.cjs", "renderer/index.html"]) {
  if (!existsSync(join(build, asset))) throw new Error(`Missing build asset ${asset}`)
}
verifyNativeAssets(join(gateway, "node_modules/@i-harness/sandbox-windows-psec"))
verifyWslAssets(join(gateway, "node_modules/@i-harness/sandbox-wsl/worker"))
const desktop = join(repo, "packages/desktop")
const electronExe = createRequire(join(desktop, "package.json"))("electron")
mkdirSync(out)
cpSync(dirname(electronExe), out, {recursive: true, dereference: true})
renameSync(join(out, "electron.exe"), join(out, "I-harness.exe"))
const app = join(out, "resources/app")
cpSync(build, join(app, "out"), {recursive: true, dereference: true})
cpSync(join(desktop, "licenses"), join(app, "licenses"), {recursive: true})
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"]) cpSync(join(repo, name), join(app, name))
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"))
writeFileSync(join(app, "package.json"), JSON.stringify({name: manifest.name, productName: "I-harness", version: manifest.version, type: "module", main: "./out/main/index.js"}, null, 2) + "\n")
cpSync(gateway, join(out, "resources/gateway"), {recursive: true, dereference: true})
for (const name of ["koffi", `@koromix/koffi-${process.platform}-${process.arch}`]) {
  copyRuntimePackage(runtimePackageRoot(name, join(gateway, "cli")), join(app, "node_modules", ...name.split("/")))
}
console.log(`Desktop candidate: ${join(out, "I-harness.exe")}`)
