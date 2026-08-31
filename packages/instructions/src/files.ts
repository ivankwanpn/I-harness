import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { homedir } from "node:os"

export interface InstructionFile { absolutePath: string; displayPath: string; content: string }

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"]

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

// R-A5: discovery order = global → workspace ancestors → workspace (closest
// last, so rendered instructions put the workspace file at the end/most
// salient). AGENTS.md wins over CLAUDE.md per directory — a dir contributes
// AT MOST ONE candidate (AGENTS.md preferred), matching the test contract.
export function discoverInstructionPaths(workspace: string, home = homedir()): string[] {
  const dirs = ancestorDirs(workspace)
  const all: string[] = dirs.flatMap((dir) => {
    const agents = join(dir, "AGENTS.md")
    if (existsSync(agents)) return [agents]
    const claude = join(dir, "CLAUDE.md")
    return existsSync(claude) ? [claude] : []
  })
  const homeDirs = [join(home), join(home, ".claude")]
  for (const hd of homeDirs) {
    const global = CANDIDATES.map((c) => join(hd, c)).filter((p) => existsSync(p))[0]
    if (global !== undefined && !all.includes(global)) all.unshift(global)
  }
  // dedupe while keeping global-first order
  const seen = new Set<string>()
  return all.filter((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return true
  })
}

function ancestorDirs(workspace: string): string[] {
  const dirs: string[] = []
  let d = workspace
  while (true) {
    dirs.unshift(d)
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return dirs
}

export function loadInstructionFiles(workspace: string, home?: string): InstructionFile[] {
  const result: InstructionFile[] = []
  for (const p of discoverInstructionPaths(workspace, home)) {
    try {
      const content = readFileSync(p, "utf8")
      result.push({ absolutePath: p, displayPath: relative(workspace, p).split(sep).join("/"), content })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return result
}

export function renderInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return ""
  return files.map((f) => `### ${f.displayPath}\n\n${f.content.trim()}`).join("\n\n")
}
