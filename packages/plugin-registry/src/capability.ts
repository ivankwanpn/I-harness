/**
 * Capability introspection for a plugin package directory (disk sniffing only).
 *
 * Plugin code is never executed here — capabilities are derived purely from the
 * file tree: a non-empty "skills/" dir, a "commands/" dir, a ".mcp.json" file,
 * and a parse-safe package.json declaring a server entry (exports["./server"]
 * or a main field). A package.json is never imported/required/dynamically
 * loaded; it is only JSON.parsed. A missing or broken package.json simply means
 * "not executable" (the host shows the plugin as unsupported).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** The capability dimensions a plugin can advertise. */
export type Capability = "skills" | "commands" | "mcp"

/** Introspected capabilities of one plugin package on disk. `executable`
 * means the plugin carries its own server entry (package.json exports
 * ["./server"] or main); the host does not execute it itself. */
export interface Capabilities {
  skills: boolean
  commands: boolean
  mcp: boolean
  executable: boolean
}

/**
 * Sniff the capabilities of a plugin directory. Purely lexical (existsSync +
 * one JSON.parse): nothing is executed or imported. A missing directory
 * yields all-false, so an uninstalled id never throws.
 */
export function inspectCapabilities(pluginDir: string): Capabilities {
  return {
    skills: existsSync(join(pluginDir, "skills")),
    commands: existsSync(join(pluginDir, "commands")),
    mcp: existsSync(join(pluginDir, ".mcp.json")),
    executable: hasServerEntry(pluginDir),
  }
}

/** package.json declares a server entry (exports["./server"] or main)? */
function hasServerEntry(pluginDir: string): boolean {
  let text: string
  try {
    text = readFileSync(join(pluginDir, "package.json"), "utf8")
  } catch {
    return false // missing package.json → not a runnable server plugin
  }
  let pkg: unknown
  try {
    pkg = JSON.parse(text) // parse-safe: never import/require/eval the package
  } catch {
    return false // broken JSON → treat as not executable
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return false
  const p = pkg as Record<string, unknown>
  if (typeof p.main === "string" && p.main.trim() !== "") return true
  const ex = p.exports
  if (typeof ex !== "object" || ex === null || Array.isArray(ex)) return false
  const server = (ex as Record<string, unknown>)["./server"]
  if (server === undefined) return false
  // Either a path string or an export-descriptor object counts as a server entry.
  return typeof server === "string" || (typeof server === "object" && server !== null)
}
