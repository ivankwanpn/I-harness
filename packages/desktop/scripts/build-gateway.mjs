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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const gatewayRoot = join(repoRoot, "packages", "desktop-gateway")
const outDir = join(packageRoot, ".gateway-dist")
const modulesDir = join(outDir, "node_modules")

function packageRootOf(name, fromDir) {
  const require = createRequire(join(fromDir, "package.json"))
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    let current = dirname(require.resolve(name))
    let fallback
    while (current !== dirname(current)) {
      const manifest = join(current, "package.json")
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"))
        if (parsed.name === name) return current
        fallback ??= current
      }
      current = dirname(current)
    }
    if (fallback !== undefined) return fallback
    throw new Error(`cannot locate package root for ${name} (from ${fromDir})`)
  }
}

function dependenciesOf(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]
}

const copied = new Set()

/** Copy one dependency (and its own deps) into the shipped node_modules.
 * Platform packages for other OSes are optional and simply not installed here. */
function copyDependency(name, fromDir, required = false) {
  if (copied.has(name)) return
  copied.add(name)
  let source
  try {
    source = packageRootOf(name, fromDir)
  } catch (error) {
    if (required) throw error
    console.warn(`skip unavailable optional dependency ${name}`)
    return
  }
  const target = join(modulesDir, ...name.split("/"))
  cpSync(source, target, { recursive: true, dereference: true })
  for (const child of dependenciesOf(source)) {
    if (child.startsWith("@types/")) continue
    copyDependency(child, source, false)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(modulesDir, { recursive: true })

// The gateway itself, plus every dependency it declares.
cpSync(join(gatewayRoot, "src"), join(outDir, "cli", "src"), { recursive: true, dereference: true })
cpSync(join(gatewayRoot, "package.json"), join(outDir, "cli", "package.json"))
for (const dependency of dependenciesOf(gatewayRoot)) {
  copyDependency(dependency, gatewayRoot, true)
}

// tsx transpiles both the gateway and the workspace packages it imports.
copyDependency("tsx", repoRoot, true)

console.log(`gateway runtime: ${outDir} (${copied.size} packages shipped)`)
