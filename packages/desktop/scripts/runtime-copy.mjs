import { cpSync, existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, sep } from "node:path"

export function runtimePackageRoot(name, fromDir) {
  const require = createRequire(join(fromDir, "package.json"))
  const candidates = []
  for (const specifier of [`${name}/package.json`, name]) {
    try { candidates.push(dirname(require.resolve(specifier))) } catch { /* exports may expose only subpaths */ }
  }
  for (const start of candidates) {
    let current = start
    while (current !== dirname(current)) {
      const manifest = join(current, "package.json")
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return current
      current = dirname(current)
    }
  }
  throw new Error(`cannot locate package root for ${name} (from ${fromDir})`)
}

/** Package payload only; dependency graph ownership belongs to the bundle. */
export function copyRuntimePackage(source, target) {
  cpSync(source, target, {
    recursive: true, dereference: true,
    filter(path) {
      const parts = relative(source, path).split(sep)
      return !parts.some((part) => ["node_modules", ".git", ".vite", "test", "tests"].includes(part))
    },
  })
}
