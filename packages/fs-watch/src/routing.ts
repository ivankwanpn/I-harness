import { dirname, resolve } from "node:path"
import { FsWatchError } from "./types.ts"

const key = (path: string) => {
  const full = resolve(path).replace(/\\/g, "/")
  return process.platform === "win32" ? full.toLowerCase() : full
}
const below = (path: string, root: string) => path.startsWith(root.endsWith("/") ? root : `${root}/`)

/** Physical traversal only. It never changes the public selection or reads a
 * scope obtained from an event. Every permitted route is derived from roots. */
export function routingPlan(roots: string[], ignore: ReadonlySet<string>) {
  const selected = roots.map(key)
  const originals = new Map(roots.map(root => [key(root), root]))
  const routes = new Map<string, string>()
  const directories = new Set<string>()
  for (const root of roots) {
    let node = root, depth = 0
    for (;;) {
      if (++depth > 128) throw new FsWatchError("FS_WATCH_CAPACITY", "Watch routing ancestry exceeded")
      routes.set(key(node), node)
      if (routes.size > 4096) throw new FsWatchError("FS_WATCH_CAPACITY", "Watch routing nodes exceeded")
      const parent = dirname(node)
      if (parent === node) break
      directories.add(key(parent))
      node = parent
    }
  }
  const isSelected = (path: string) => {
    const full = key(path)
    return selected.includes(full) || (selected.some(root => below(full, root))
      && !resolve(path).replace(/\\/g, "/").split("/").some(segment => ignore.has(segment)))
  }
  return {
    directories: [...routes].filter(([path]) => directories.has(path)).map(([, path]) => path),
    selected: isSelected,
    directory: (path: string) => { if (routes.has(key(path))) directories.add(key(path)) },
    topology: (path: string) => directories.has(key(path)),
    original: (path: string) => originals.get(key(path)),
    ignored: (path: string) => !routes.has(key(path)) && !isSelected(path),
  }
}
