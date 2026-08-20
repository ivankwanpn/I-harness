import type { ExecService } from "@i-harness/exec"
import type { Tool } from "@i-harness/core-tools"

// Directory names ripgrep must never descend into for discovery (dsh
// GLOB_VCS_EXCLUDES). Each is excluded twice: the bare form prunes during
// traversal; the /** form covers a search root at/inside the directory.
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const
const GLOB_MAX_RESULTS = 100
const GREP_MAX_MATCHES = 250

let rgPathPromise: Promise<string> | undefined

// Lazy, memoized: `@vscode/ripgrep` resolves its platform package at module
// evaluation, so a static import would fail the whole loader on a partial
// install. Resolution at the call boundary keeps the failure at first use.
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= import("@vscode/ripgrep").then((m) => m.rgPath)
  return rgPathPromise
}

export interface FsSearchToolDeps {
  exec: ExecService
}

export interface GlobResult {
  matches: string[]
  error?: string
}

export interface GrepMatch {
  path: string
  line: number
  text: string
}

export interface GrepResult {
  matches: GrepMatch[]
  error?: string
}

export function createFsSearchTools(deps: FsSearchToolDeps): Tool[] {
  const glob: Tool<{ pattern: string; path?: string }, GlobResult> = {
    name: "glob",
    description: "find files whose paths match a glob pattern (e.g. **/*.txt)",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern to match paths against" },
        path: { type: "string", description: "directory to search (default: workspace root)" },
      },
      required: ["pattern"],
    },
    exposure: "deferred",
    searchHint: "find files by pattern",
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (args) => {
      if (args.pattern.trim().length === 0) throw new Error("pattern must be a non-empty string")
      try {
        const rgPath = await resolveRgPath()
        const parts = [
          "--files",
          `--glob=${args.pattern}`,
          "--sort=modified",
          "--no-ignore",
          "--hidden",
          ...GLOB_VCS_EXCLUDES.flatMap((n) => [`--glob=!**/${n}`, `--glob=!**/${n}/**`]),
          "--",
          ".",
        ]
        // Run with cwd inside the search root so rg emits paths relative to it;
        // an absolute search root would otherwise yield absolute paths. With no
        // path arg, cwd is left unset (the process cwd) and "." searches it.
        const result = await deps.exec.run({ argv: [rgPath, ...parts], ...(args.path !== undefined ? { cwd: args.path } : {}) })
        // rg exits 1 with empty stdout when nothing matches — a normal empty result.
        // Any other non-zero exit (2+ = rg error, -1 = spawn failure) is a genuine
        // failure: surface it as an error note instead of a silent empty success.
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return { matches: [], error: result.stderr?.trim() || `ripgrep failed (exit ${result.exitCode})` }
        }
        // Paths come back relative to the search root but with a "./" prefix
        // (".\" on Windows); strip it so callers get bare relative paths.
        const matches = result.stdout
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0)
          .map((l) => (l.startsWith("./") ? l.slice(2) : l.startsWith(".\\") ? l.slice(2) : l))
          .slice(0, GLOB_MAX_RESULTS)
        return { matches }
      } catch (err) {
        return { matches: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  }

  const grep: Tool<{ pattern: string; path?: string; include?: string }, GrepResult> = {
    name: "grep",
    description: "search files for lines matching a regex pattern, returning path, line number, and text",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern to search for" },
        path: { type: "string", description: "directory to search (default: .)" },
        include: { type: "string", description: "optional glob filter for files to search" },
      },
      required: ["pattern"],
    },
    exposure: "deferred",
    searchHint: "search file contents by pattern",
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (args) => {
      if (args.pattern.length === 0) throw new Error("pattern must be a non-empty string")
      try {
        const rgPath = await resolveRgPath()
        const parts = ["--json", `--regexp=${args.pattern}`]
        if (args.include !== undefined) parts.push(`--glob=${args.include}`)
        parts.push("--", args.path ?? ".")
        const result = await deps.exec.run({ argv: [rgPath, ...parts] })
        // rg exits 1 with no match lines when nothing matches — a normal empty
        // result. Any other non-zero exit (2+ = rg error, -1 = spawn failure) is
        // a genuine failure: surface it as an error note, not empty success.
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return { matches: [], error: result.stderr?.trim() || `ripgrep failed (exit ${result.exitCode})` }
        }
        const matches: GrepMatch[] = []
        for (const line of result.stdout.split("\n")) {
          if (line.trim() === "") continue
          try {
            const entry = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
            if (entry.type === "match" && entry.data) {
              matches.push({
                path: entry.data.path?.text ?? "",
                line: entry.data.line_number ?? 0,
                text: (entry.data.lines?.text ?? "").trimEnd(),
              })
              if (matches.length >= GREP_MAX_MATCHES) break
            }
          } catch {
            // Skip a malformed JSON line; the parse loop continues.
          }
        }
        return { matches }
      } catch (err) {
        return { matches: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  }

  return [glob, grep]
}
