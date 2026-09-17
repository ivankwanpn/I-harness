/**
 * Markdown command discovery + a minimal frontmatter parser (self-made — no
 * yaml dependency). A plugin declares commands as `commands/*.md`; the command
 * name is the file name without the `.md` extension and the body is the
 * markdown after an optional `---\nkey: value\n---` fence.
 *
 * Supported frontmatter keys (single-line values, quotes stripped):
 * `description` and `argument-hints` (alias `argument_hints` / `argumentHints`).
 * No closed fence → the whole text is treated as the body. Nothing is executed
 * here: the files are only read and parsed (D2).
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { CommandDescriptor } from "./types.ts"

/** Strip one value of surrounding single/double quotes (frontmatter convention). */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const q = value[0]
    if ((q === '"' || q === "'") && value[value.length - 1] === q) return value.slice(1, -1)
  }
  return value
}

/**
 * Parse one command markdown file into a CommandDescriptor. `fileName` yields
 * the command name (basename without the .md extension). Frontmatter keys are
 * matched case-insensitively with `-`/`_` treated as equivalent.
 *
 * A key we do NOT honour is recorded in `unsupported` rather than dropped
 * (spec 2026-09-17 §3 decision 3): a command declaring `allowed-tools` would
 * otherwise believe it is restricted while nothing enforces it — the
 * "looks successful, did nothing" defect this repo keeps deleting. The command
 * still parses; the limitation is what gets reported.
 */
export function parseCommandMarkdown(fileName: string, text: string): CommandDescriptor {
  const name = fileName.replace(/\.md$/i, "")
  const lines = text.split(/\r?\n/)
  const meta: { description?: string; argumentHints?: string } = {}
  const unsupported: string[] = []
  let bodyStart = 0
  if (lines[0]?.trim() === "---") {
    let fence = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        fence = i
        break
      }
    }
    if (fence !== -1) {
      for (let i = 1; i < fence; i++) {
        const line = lines[i]!
        const colon = line.indexOf(":")
        if (colon <= 0) continue
        const rawKey = line.slice(0, colon).trim()
        const key = rawKey.toLowerCase().replace(/[-_]/g, "")
        const value = stripQuotes(line.slice(colon + 1).trim())
        if (value === "") continue
        if (key === "description") meta.description = value
        // `argument-hint` is the OFFICIAL spelling (it is what Anthropic's own
        // commands use); `argument-hints` is ours. Both are honoured — the
        // singular was silently dropped before 2026-09-17, which is how a
        // frontmatter key came to be ignored without anyone noticing.
        else if (key === "argumenthints" || key === "argumenthint") meta.argumentHints = value
        else if (!unsupported.includes(rawKey)) unsupported.push(rawKey)
      }
      bodyStart = fence + 1
    }
  }
  return {
    name,
    ...meta,
    body: lines.slice(bodyStart).join("\n").trim(),
    ...(unsupported.length > 0 ? { unsupported } : {}),
  }
}

/**
 * Scan a commands directory (top-level `*.md` files only, v1) into
 * CommandDescriptor[], sorted by name. A missing/unreadable directory → [];
 * a file that cannot be read is skipped with a warning.
 */
export function describeCommands(dir: string): CommandDescriptor[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => /\.md$/i.test(f))
  } catch {
    return [] // missing dir (e.g. an mcp-only plugin) → no commands
  }
  const out: CommandDescriptor[] = []
  for (const name of names.sort()) {
    try {
      out.push(parseCommandMarkdown(name, readFileSync(join(dir, name), "utf8")))
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn(`[plugin-registry] skipping unreadable command file ${join(dir, name)}: ${reason}`)
    }
  }
  return out
}
