/**
 * Minimal frontmatter reader (self-made — this package takes no yaml dependency,
 * deliberately). Shared by the command and the agent parser so the two cannot
 * drift: a format fix has to reach both, and the block-scalar gap proved that a
 * per-parser copy is how one of them silently falls behind.
 *
 * Supported: single-line `key: value` (surrounding quotes stripped) and the
 * block scalars `|` / `>` with an optional `+`/`-` chomping indicator, whose
 * value is the INDENTED BLOCK below the key. A key this layer does not recognise
 * is the CALLER's business — it reports what it saw, in file order, and each
 * parser decides which keys it honours and which it records as unsupported.
 */

export interface FrontmatterField {
  /** The key exactly as written — what gets recorded when unsupported. */
  raw: string
  /** Normalized for matching: lowercased, `-` and `_` removed. */
  key: string
  value: string
}

export interface Frontmatter {
  fields: FrontmatterField[]
  /** Everything after the closing fence, newline-normalized and UNTRIMMED; the
   * whole text when there is no closed fence (that is the documented behaviour,
   * not a fallback). */
  body: string
  /** The 1-indexed line the body starts on — 0 when the body is the whole text. */
  bodyStart: number
}

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
 * field parsed here, so they are dropped. (The `+`/`-` chomping indicators are
 * ACCEPTED and ignored — keeping every trailing newline buys nothing for a
 * description and would make the stored value differ from its rendered form.) */
function normalizeBlock(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "")
}

/** Read the frontmatter fence (if any) and return its fields plus the body. */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split(/\r?\n/)
  const fields: FrontmatterField[] = []
  if (lines[0]?.trim() !== "---") return { fields, body: lines.join("\n"), bodyStart: 0 }

  let fence = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") { fence = i; break }
  }
  // An unclosed fence is not frontmatter: the whole text is the body.
  if (fence === -1) return { fields, body: lines.join("\n"), bodyStart: 0 }

  let i = 1
  while (i < fence) {
    const line = lines[i]!
    const colon = line.indexOf(":")
    // Not a `key: value` line. An INDENTED line is block-scalar content the
    // branch below already consumed, or an orphan continuation — never a key,
    // which is what stopped `Context:`/`user:`/`assistant:` (the lines inside a
    // real agent's `description: |`) from being read as keys.
    if (colon <= 0 || /^[ \t]/.test(line)) { i++; continue }
    const raw = line.slice(0, colon).trim()
    const key = raw.toLowerCase().replace(/[-_]/g, "")
    const rest = line.slice(colon + 1).trim()
    const marker = /^([|>])([+-]?)$/.exec(rest)
    if (marker) {
      // The value is the indented block BELOW, never the marker itself.
      const rawLines: string[] = []
      let j = i + 1
      for (; j < fence; j++) {
        const b = lines[j]!
        if (b.trim() === "") { rawLines.push(""); continue }
        if (!/^[ \t]/.test(b)) break // an un-indented line ends the block
        rawLines.push(b)
      }
      const first = rawLines.find((b) => b.trim() !== "")
      const indent = first === undefined ? 0 : first.length - first.trimStart().length
      const content = rawLines.map((b) => (b.trim() === "" ? "" : b.slice(indent)))
      fields.push({
        raw,
        key,
        value: normalizeBlock(marker[1] === "|" ? content.join("\n") : foldBlock(content)),
      })
      i = j
      continue
    }
    fields.push({ raw, key, value: stripQuotes(rest) })
    i++
  }
  return { fields, body: lines.slice(fence + 1).join("\n"), bodyStart: fence + 1 }
}
