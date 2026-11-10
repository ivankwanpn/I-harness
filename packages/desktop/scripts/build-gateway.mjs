#!/usr/bin/env node
// Ship the approved gateway host inside the app's resources.
//
// Usage (from packages/desktop): node scripts/build-gateway.mjs
// Output: .gateway-dist/  →  extraResources → <app>/resources/gateway/
//
// Why a source tree instead of a single-file bundle: the gateway's dependency
// graph resolves real files relative to `import.meta.url` (sandbox ACL runner,
// provider model catalogue, tsx loader). Copying the actual package trees with
// their resolved dependencies keeps the packaged runtime identical to the
// launch path the e2e tests already exercise.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { transformSync } from "esbuild"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyRuntimePackage, runtimePackageRoot } from "./runtime-copy.mjs"
import { verifyNativeAssets } from "../../../scripts/runtime-native-assets.mjs"
import { copyWslAssets, verifyWslAssets } from "../../../scripts/runtime-wsl-assets.mjs"
import { verifyAclWaitSourceAssets } from "../../../scripts/runtime-acl-wait-assets.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const gatewayRoot = join(repoRoot, "packages", "desktop-gateway")
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("Usage: build-gateway.mjs [--out NEW_REPOSITORY_DIRECTORY]")
const outDir = args.length ? resolve(repoRoot, args[1]) : join(packageRoot, ".gateway-dist")
const tail = relative(repoRoot, outDir)
if (!tail || tail === ".." || tail.startsWith("..") || isAbsolute(tail)) throw new Error("Gateway output must remain within the repository")
if (args.length && existsSync(outDir)) throw new Error("Explicit gateway candidate output must be a new directory")
const modulesDir = join(outDir, "node_modules")

function dependenciesOf(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  return [...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, required: true })), ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, required: false }))]
}

const copied = new Set()
verifyNativeAssets(join(repoRoot, "packages/sandbox-windows-psec"), { sources: true })
verifyAclWaitSourceAssets(join(repoRoot, "packages/sandbox-windows-acl"))

/** Copy one dependency (and its own deps) into the shipped node_modules.
 * Platform packages for other OSes are optional and simply not installed here. */
function copyDependency(name, fromDir, required = false) {
  if (copied.has(name)) return
  let source
  try {
    source = runtimePackageRoot(name, fromDir)
  } catch (error) {
    if (required) throw error
    console.warn(`skip unavailable optional dependency ${name}`)
    return
  }
  const target = join(modulesDir, ...name.split("/"))
  copied.add(name)
  copyRuntimePackage(source, target)
  for (const child of dependenciesOf(source)) {
    if (child.name.startsWith("@types/")) continue
    copyDependency(child.name, source, child.required)
  }
}

/** Compile the shipped workspace packages in place: esbuild strips TypeScript,
 * then relative .ts specifiers and package export maps move to .js. The point is
 * to remove the runtime tsx loader from the packaged gateway entirely. */
function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\.ts\2/g, (_, lead, quote, spec) => `${lead}${quote}${spec}.js${quote}`)
    .replace(/(\bimport\s*)(["'])([^"']+)\.ts\2/g, (_, lead, quote, spec) => `${lead}${quote}${spec}.js${quote}`)
}
function rewritePackageJson(value) {
  if (typeof value === "string") return value.endsWith(".ts") ? value.slice(0, -3) + ".js" : value
  if (Array.isArray(value)) return value.map(rewritePackageJson)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePackageJson(item)]))
  return value
}
function compileTree(root) {
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { pending.push(full); continue }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue
      const source = readFileSync(full, "utf8")
      const result = transformSync(source, { loader: "ts", format: "esm", target: "node24", sourcefile: full, legalComments: "none" })
      writeFileSync(full.slice(0, -3) + ".js", rewriteSpecifiers(result.code))
      rmSync(full)
    }
  }
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== "package.json") continue
    const file = join(entry.parentPath, entry.name)
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify(rewritePackageJson(parsed), null, 2) + "\n")
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(modulesDir, { recursive: true })

// Keep the real Gateway beside its workspace siblings: its internal relative
// imports must resolve to the same module instances as package-name imports.
const shippedGateway = join(modulesDir, "@i-harness", "desktop-gateway")
copyRuntimePackage(gatewayRoot, shippedGateway)
copied.add("@i-harness/desktop-gateway")
mkdirSync(join(outDir, "cli", "src"), { recursive: true })
cpSync(join(gatewayRoot, "package.json"), join(outDir, "cli", "package.json"))
writeFileSync(join(outDir, "cli", "src", "host.ts"), 'export * from "../../node_modules/@i-harness/desktop-gateway/src/host.ts"\n')
writeFileSync(join(outDir, "cli", "src", "cli.ts"), `import { pathToFileURL } from "node:url"
import { main } from "../../node_modules/@i-harness/desktop-gateway/src/cli.ts"
export { main }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
    console.error("[desktop-gateway] fatal: " + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
`)
for (const dependency of dependenciesOf(gatewayRoot)) {
  copyDependency(dependency.name, gatewayRoot, dependency.required)
}

compileTree(join(modulesDir, "@i-harness"))
compileTree(join(outDir, "cli"))
verifyNativeAssets(join(modulesDir, "@i-harness/sandbox-windows-psec"))
const wslWorker = join(modulesDir, "@i-harness/sandbox-wsl/worker")
copyWslAssets(join(repoRoot, "packages/sandbox-wsl/worker/runner.py"), wslWorker)
verifyWslAssets(wslWorker)

console.log(`gateway runtime: ${outDir} (${copied.size} packages shipped)`)
