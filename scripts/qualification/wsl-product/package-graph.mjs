import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
const repo = resolve(import.meta.dirname, "../../..")
const packages = new Map()
for (const parent of ["apps", "packages"]) for (const folder of readdirSync(join(repo, parent))) {
  try {
    const manifest = JSON.parse(readFileSync(join(repo, parent, folder, "package.json"), "utf8"))
    packages.set(manifest.name, manifest)
  } catch (error) {if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error}
}
const edges = new Map([...packages].map(([name, manifest]) => [name, [...Object.keys({...manifest.dependencies, ...manifest.optionalDependencies})].filter(child => packages.has(child))]))
const visited = new Set(), active = new Set()
function visit(name, stack = []) {
  if (active.has(name)) throw new Error(`Production dependency cycle: ${[...stack, name].join(" -> ")}`)
  if (visited.has(name)) return
  active.add(name)
  for (const child of edges.get(name) ?? []) visit(child, [...stack, name])
  active.delete(name); visited.add(name)
}
for (const name of edges.keys()) visit(name)
const reachable = new Set()
function reach(name) {if (reachable.has(name)) return; reachable.add(name); for (const child of edges.get(name) ?? []) reach(child)}
for (const root of ["@i-harness/cli", "@i-harness/desktop"]) {if (!packages.has(root)) throw new Error(`Missing application ${root}`); reach(root)}
const report = {date: new Date().toISOString(), workspacePackages: packages.size, applicationReachable: reachable.size, productionCycles: 0, unreachable: [...packages.keys()].filter(name => !reachable.has(name))}
const out = join(repo, ".tmp/wsl-product-root-verify-20261009")
mkdirSync(out, {recursive: true}); writeFileSync(join(out, "package-graph.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report))
