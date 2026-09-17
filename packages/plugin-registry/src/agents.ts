/**
 * Markdown subagent discovery. A plugin declares agents as `agents/*.md`:
 * frontmatter plus a body that IS the system prompt. Same shape as commands.ts —
 * the fence is read by the shared `frontmatter.ts` so the two parsers cannot
 * drift apart on the format itself.
 *
 * Honoured keys (matched case-insensitively, `-`/`_` equivalent): `name`,
 * `description`, `tools`, `model`. Everything else is recorded in `unsupported`
 * rather than dropped — the CommandDescriptor precedent, and the reason `color`
 * (display-only in Claude Code, used by 20 of the 35 real files) is visible
 * instead of invisible.
 *
 * Nothing is executed here: the files are only read and parsed.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "./frontmatter.ts"
import type { AgentDescriptor } from "./types.ts"

/**
 * Split a `tools:` value into entries. Two forms occur in the real corpus — 19
 * files use comma-separated (`Read, Glob, Grep`), 4 use a JSON array
 * (`["Read", "Grep"]`).
 *
 * A comma INSIDE parentheses does NOT split: the scoped form
 * `Agent(a:one, a:two)` is ONE entry, and splitting it yields the fragments
 * `Agent(a:one` and `a:two)` — neither of which resolves to a tool, so both
 * would be dropped in silence with the entry's real intent lost.
 */
function parseToolList(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean)
    } catch {
      // not valid JSON → fall through and let the comma form read it as written
    }
  }
  const out: string[] = []
  let depth = 0
  let current = ""
  for (const ch of trimmed) {
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; continue }
    current += ch
  }
  out.push(current.trim())
  return out.filter(Boolean)
}

/**
 * Parse one agent markdown file into an AgentDescriptor. The name is the
 * frontmatter `name` when declared, else the file name — measured, all 32 real
 * files that declare one have it equal to the file name, so the fallback is
 * never exercised by the corpus and the precedence has to be pinned synthetically.
 */
export function parseAgentMarkdown(fileName: string, text: string): AgentDescriptor {
  const base = fileName.replace(/\.md$/i, "")
  const { fields, body } = parseFrontmatter(text)
  const meta: { name?: string; description?: string; model?: string; tools?: string[] } = {}
  const unsupported: string[] = []
  for (const field of fields) {
    if (field.value === "") continue
    if (field.key === "name") meta.name = field.value
    else if (field.key === "description") meta.description = field.value
    else if (field.key === "model") meta.model = field.value
    else if (field.key === "tools") meta.tools = parseToolList(field.value)
    else if (!unsupported.includes(field.raw)) unsupported.push(field.raw)
  }
  return {
    name: meta.name ?? base,
    description: meta.description ?? "",
    systemPrompt: body.trim(),
    ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(unsupported.length > 0 ? { unsupported } : {}),
  }
}

/**
 * Scan an agents directory (top-level `*.md` files only, v1) into
 * AgentDescriptor[], sorted by the resulting NAME — not by file name, because a
 * file may declare a `name` that differs from it and the host lists what it will
 * actually show. A missing/unreadable directory → []; a file that cannot be read
 * is skipped with a warning, the same contract describeCommands has, so one bad
 * file never costs the host every agent.
 */
export function describeAgents(dir: string): AgentDescriptor[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => /\.md$/i.test(f))
  } catch {
    return [] // missing dir (e.g. a skills-only plugin) → no agents
  }
  const out: AgentDescriptor[] = []
  for (const name of names.sort()) {
    try {
      out.push(parseAgentMarkdown(name, readFileSync(join(dir, name), "utf8")))
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn(`[plugin-registry] skipping unreadable agent file ${join(dir, name)}: ${reason}`)
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
