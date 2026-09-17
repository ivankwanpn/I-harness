/**
 * Markdown command discovery. A plugin declares commands as `commands/*.md`; the
 * command name is the file name without the `.md` extension and the body is the
 * markdown after an optional `---\nkey: value\n---` fence. The fence itself is
 * read by `frontmatter.ts`, shared with the agent parser so the two cannot drift.
 *
 * Honoured frontmatter keys (matched case-insensitively, `-`/`_` equivalent):
 * `description` and `argument-hints` (aliases `argument_hints` / `argumentHints`).
 * Nothing is executed here: the files are only read and parsed (D2).
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "./frontmatter.ts"
import type { CommandDescriptor } from "./types.ts"

/**
 * Parse one command markdown file into a CommandDescriptor. `fileName` yields
 * the command name (basename without the .md extension).
 *
 * A key we do NOT honour is recorded in `unsupported` rather than dropped
 * (spec 2026-09-17 §3 decision 3): a command declaring `allowed-tools` would
 * otherwise believe it is restricted while nothing enforces it — the
 * "looks successful, did nothing" defect this repo keeps deleting. The command
 * still parses; the limitation is what gets reported.
 */
export function parseCommandMarkdown(fileName: string, text: string): CommandDescriptor {
  const name = fileName.replace(/\.md$/i, "")
  const { fields, body } = parseFrontmatter(text)
  const meta: { description?: string; argumentHints?: string } = {}
  const unsupported: string[] = []
  for (const field of fields) {
    if (field.value === "") continue
    if (field.key === "description") meta.description = field.value
    // `argument-hint` is the OFFICIAL spelling (it is what Anthropic's own
    // commands use); `argument-hints` is ours. Both are honoured — the singular
    // was silently dropped before 2026-09-17, which is how a frontmatter key
    // came to be ignored without anyone noticing.
    else if (field.key === "argumenthints" || field.key === "argumenthint") meta.argumentHints = field.value
    else if (!unsupported.includes(field.raw)) unsupported.push(field.raw)
  }
  return {
    name,
    ...meta,
    body: body.trim(),
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
