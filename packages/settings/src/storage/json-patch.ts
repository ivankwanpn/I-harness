import { isRecord } from "../normalize/primitives.ts"
import { mergeRawLayers } from "./layers.ts"

/** Fail-closed leaf-patch error: a document the patchter cannot rewrite
 * safely stays untouched (the caller surfaces it; nothing is destroyed). */
export class SettingsPatchError extends Error {
  readonly code = "settings-leaf-patch" as const
  constructor(message: string) {
    super(`[settings-leaf-patch] ${message}`)
    this.name = "SettingsPatchError"
  }
}

const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|\*\/)/

const BLOCK_START = /^\s*\/\*/

const BLOCK_END = /\*\//

interface AnchoredLine {
  text: string
  /** index of the next structural line (raw's structural index) */
  anchor: number
}

/** Split raw text into structural lines (strippable JSON) + comment/blank
 * lines anchored to the next structural line. Full-line comments only (an
 * inline comment inside a value string is indistinguishable — fail-closed
 * rather than corrupt). */
function splitRawLines(raw: string): { structural: string[]; extras: AnchoredLine[] } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n")
  const structural: string[] = []
  const extras: AnchoredLine[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      extras.push({ text: line, anchor: structural.length })
      if (BLOCK_END.test(trimmed)) inBlock = false
      continue
    }
    if (BLOCK_START.test(trimmed)) {
      extras.push({ text: line, anchor: structural.length })
      if (!(BLOCK_END.test(trimmed.slice(trimmed.indexOf("/*") + 2)))) inBlock = true
      continue
    }
    if (COMMENT_LINE.test(trimmed) || trimmed === "") {
      extras.push({ text: line, anchor: structural.length })
      continue
    }
    structural.push(line)
  }
  return { structural, extras }
}

/** Comment-tolerant parse for READ paths (a hand-edited comment-bearing
 * document still loads); throws when even the stripped text is invalid. */
export function parseDocumentTolerant(raw: string): Record<string, unknown> {
  const { structural } = splitRawLines(raw)
  const parsed = JSON.parse(structural.join("\n")) as unknown
  if (!isRecord(parsed)) throw new Error("settings document is not an object")
  return parsed
}

/**
 * Comment/blank-line-preserving JSON patch. The raw document is parsed after
 * stripping FULL-LINE comments (`//`, `#`, `/* … *​/`, `*`) and blank lines; the
 * patch deep-merges into it; the result is re-serialized with every comment
 * line re-anchored to its positional line (identical structural layout = the
 * file this package writes; a REORGANIZED document degrades to preserving the
 * leading/trailing blocks — still no data loss, and a fault unsafe to fix
 * throws SettingsPatchError BEFORE writing).
 */
export function patchJsonDocumentKeepingComments(raw: string, patch: Record<string, unknown>): string {
  const { structural, extras } = splitRawLines(raw)
  // Fail-closed: a document that does not parse even comment-stripped is left
  // untouched (the caller surfaces; the file is never destroyed).
  const baseDoc = parseDocumentTolerant(raw)
  const merged = mergeRawLayers([{ raws: baseDoc }, { raws: patch }])
  const oldLines = JSON.stringify(baseDoc, null, 2).split("\n")
  const newLines = JSON.stringify(merged, null, 2).split("\n")

  // Canonical alignment: raw structural lines must be exactly the canonical
  // re-serialization of the parsed doc (the formatter this package writes).
  const canonical = structural.length === oldLines.length
    && structural.every((line, i) => line === oldLines[i])
  if (!canonical) {
    // Degraded preservation: leading + trailing comment blocks only; interior
    // extras relocate to the end (they never delete user data, and a compact
    // document is being normalized to the canonical layout).
    const leading = extras.filter((e) => e.anchor === 0)
    const trailing = extras.filter((e) => e.anchor === structural.length)
    return [
      ...leading.map((e) => e.text),
      ...newLines,
      ...trailing.map((e) => e.text),
    ].join("\n")
  }

  // Positional re-anchoring: key order is preserved through
  // parse→patch→stringify, so structural index k maps to the same logical
  // line when the line counts match; extras are re-emitted before it.
  if (newLines.length === oldLines.length) {
    const out: string[] = []
    for (let k = 0; k < newLines.length; k += 1) {
      for (const extra of extras) if (extra.anchor === k && !out.includes(extra.text)) out.push(extra.text)
      out.push(newLines[k])
    }
    for (const extra of extras) if (extra.anchor === structural.length && !out.includes(extra.text)) out.push(extra.text)
    return out.join("\n")
  }

  // Counts differ (a leaf set/unset changed the line count): keep the leading
  // block, the extras anchored to lines that survived verbatim, then every
  // remaining extra followed by the trailing block — deterministic, no loss.
  const out: string[] = []
  const placed = new Set<string>()
  for (const extra of extras) if (extra.anchor === 0) { out.push(extra.text); placed.add(extra.text) }
  for (const line of newLines) {
    const oldIdx = oldLines.indexOf(line)
    if (oldIdx !== -1) {
      for (const extra of extras) {
        if (extra.anchor === oldIdx && !placed.has(extra.text)) { out.push(extra.text); placed.add(extra.text) }
      }
    }
    out.push(line)
  }
  for (const extra of extras) if (!placed.has(extra.text)) out.push(extra.text)
  return out.join("\n")
}
