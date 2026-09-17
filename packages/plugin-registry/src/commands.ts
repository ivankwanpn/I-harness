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

/** YAML folded (`>`) block: runs of non-blank lines join with a space, a blank
 * line becomes a newline. */
function foldBlock(lines: string[]): string {
  let text = ""
  for (const line of lines) {
    if (line.trim() === "") { text += "\n"; continue }
    text += text === "" || text.endsWith("\n") ? line : ` ${line}`
  }
  return text
}

/** A block scalar's value: leading/trailing blank lines carry no meaning in any
 * field we parse, so they are dropped. (The `+`/`-` chomping indicators are
 * ACCEPTED and ignored — keeping every trailing newline buys nothing for a
 * description and would make the value differ from its rendered form.) */
function normalizeBlock(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "")
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
      /** Record one honoured/unsupported key. Empty values are skipped, which is
       * also what a block scalar with no content yields. */
      const take = (key: string, rawKey: string, value: string): void => {
        if (value === "") return
        if (key === "description") meta.description = value
        // `argument-hint` is the OFFICIAL spelling (it is what Anthropic's own
        // commands use); `argument-hints` is ours. Both are honoured — the
        // singular was silently dropped before 2026-09-17, which is how a
        // frontmatter key came to be ignored without anyone noticing.
        else if (key === "argumenthints" || key === "argumenthint") meta.argumentHints = value
        else if (!unsupported.includes(rawKey)) unsupported.push(rawKey)
      }
      let i = 1
      while (i < fence) {
        const line = lines[i]!
        const colon = line.indexOf(":")
        // Not a `key: value` line. An INDENTED line is block-scalar content the
        // branch below already consumed, or an orphan continuation — never a key,
        // which is what stopped `Context:`/`user:`/`assistant:` (the lines inside
        // a real agent's `description: |`) from landing in `unsupported`.
        if (colon <= 0 || /^[ \t]/.test(line)) { i++; continue }
        const rawKey = line.slice(0, colon).trim()
        const key = rawKey.toLowerCase().replace(/[-_]/g, "")
        const rest = line.slice(colon + 1).trim()
        const marker = /^([|>])([+-]?)$/.exec(rest)
        if (marker) {
          // The value is the indented block BELOW, never the marker itself.
          const raw: string[] = []
          let j = i + 1
          for (; j < fence; j++) {
            const b = lines[j]!
            if (b.trim() === "") { raw.push(""); continue }
            if (!/^[ \t]/.test(b)) break // an un-indented line ends the block
            raw.push(b)
          }
          const first = raw.find((b) => b.trim() !== "")
          const indent = first === undefined ? 0 : first.length - first.trimStart().length
          const content = raw.map((b) => (b.trim() === "" ? "" : b.slice(indent)))
          take(key, rawKey, normalizeBlock(marker[1] === "|" ? content.join("\n") : foldBlock(content)))
          i = j
          continue
        }
        take(key, rawKey, stripQuotes(rest))
        i++
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
