// @i-harness/tui — M38b G1: code-body syntax highlighting for markdown render.
// highlight.js (lib/common — the ~40-language common subset) is the engine;
// this module converts its span HTML into StyledRun rows WITHOUT any DOM
// (pure regex token walk). Every run carries codeBg:true so the Presenter
// paints md_code_bg behind the row (spec §3.1/§8: fences + language markers
// are hidden — only the body on md_code_bg + highlighted for known langs;
// unknown/missing lang → plain body in the md_code color).
// Polarity safety: styles resolve through the theme palette (present.ts) and
// quantize to hue-pinned ANSI16 families (§5.4) — no raw hljs colors.

import hljs from "highlight.js/lib/common"
import type { StyledRun, TextStyle } from "../contracts.ts"

/** hljs span class → semantic TextStyle. Base (unhighlighted) code text is
 * "md-code-text" (md_code color on md_code_bg, non-bold) — §5 md_code family.
 * Sub-classes (e.g. `hljs-title function_` — "function_") map too. */
export function classToStyle(cls: string): TextStyle {
  if (cls === "") return "md-code-text"
  const parts = cls.split(/\s+/).filter((s) => s !== "")
  const main = MAIN_CLASS[parts[0] ?? ""]
  if (main !== undefined) return main
  const sub = SUB_CLASS[parts[1] ?? ""]
  if (sub !== undefined) return sub
  return "md-code-text"
}

const MAIN_CLASS: Record<string, TextStyle> = {
  // keywords/control — md_code BOLD (§5)
  "hljs-keyword": "md-code",
  "hljs-built_in": "md-code",
  "hljs-selector-tag": "md-code",
  // strings/symbols — teal family (accent_model §5.4 hue pin)
  "hljs-string": "accent-model",
  "hljs-string-variable": "accent-model",
  "hljs-regexp": "accent-model",
  "hljs-symbol": "accent-model",
  "hljs-subst": "accent-model",
  // comments — md_muted
  "hljs-comment": "md-muted",
  "hljs-quote": "md-muted",
  "hljs-doctag": "md-muted",
  // numbers/literals/types/declarations — purple family (accent_assistant)
  "hljs-number": "accent-assistant",
  "hljs-literal": "accent-assistant",
  "hljs-meta": "accent-assistant",
  "hljs-meta-keyword": "accent-assistant",
  "hljs-meta-string": "accent-assistant",
  "hljs-title": "accent-assistant",
  "hljs-type": "accent-assistant",
  "hljs-class": "accent-assistant",
  "hljs-section": "accent-assistant",
  "hljs-selector-class": "accent-assistant",
  // identifiers/params/props — body text color
  "hljs-attribute": "text",
  "hljs-attr": "text",
  "hljs-name": "text",
  "hljs-variable": "text",
  "hljs-template-variable": "text",
  "hljs-params": "text",
  "hljs-property": "text",
  "hljs-selector-id": "text",
  "hljs-selector-attr": "text",
  // emphasis inside code (comments/strings)
  "hljs-emphasis": "md-em",
  "hljs-strong": "md-strong",
}

/** The second class hljs appends (title class_/function_/variable_/meta_). */
const SUB_CLASS: Record<string, TextStyle> = {
  "class_": "accent-assistant",
  "function_": "accent-assistant",
  "variable_": "accent-assistant",
  "meta_": "accent-assistant",
}

/** Unknown/missing language fence body: plain md_code-color rows (no hljs). */
export function plainCodeRows(code: string): StyledRun[][] {
  if (code === "") return []
  return code.split("\n").map((line) => [runBg(line, "md-code-text")])
}

function runBg(text: string, style: TextStyle): StyledRun {
  return { text, style, codeBg: true }
}

/** Non-markdown rich text may appear in hljs output (plain runs inherit the
 * code base). The decoder covers the entities hljs emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => {
      const cp = parseInt(h, 16)
      return cp > 0 ? String.fromCodePoint(cp) : "�"
    })
    .replace(/&#([0-9]+);/g, (_m, d: string) => {
      const cp = parseInt(d, 10)
      return cp > 0 ? String.fromCodePoint(cp) : "�"
    })
}

/** hljs span HTML → StyledRun rows. A nested-span stack keeps the innermost
 * class as the visible style (e.g. `${a}` inside a template string). Blank
 * code lines stay rows (empty StyledRun[]); a trailing newline does not. */
export function runsFromHtml(html: string): StyledRun[][] {
  const rows: StyledRun[][] = []
  let cur: StyledRun[] = []
  const flushRow = (): void => {
    rows.push(cur)
    cur = []
  }
  const emit = (text: string, style: TextStyle): void => {
    if (text === "") return
    const parts = decodeEntities(text).split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) flushRow()
      if (parts[i] !== "") cur.push(runBg(parts[i], style))
    }
  }
  const top = (): TextStyle => (stack.length > 0 ? stack[stack.length - 1] : "md-code-text")
  const stack: TextStyle[] = []
  const RE = /<span class="([^"]*)"(?: [^>]*)?>|<\/span>/g
  let last = 0
  for (const m of html.matchAll(RE)) {
    const idx = m.index ?? 0
    emit(html.slice(last, idx), top())
    if (m[0].startsWith("</")) {
      if (stack.length > 0) stack.pop()
    } else {
      stack.push(classToStyle(m[1] ?? ""))
    }
    last = idx + m[0].length
  }
  emit(html.slice(last), top())
  if (cur.length > 0) rows.push(cur)
  return rows
}

/** One StyledRun row per code line; unknown/unloaded language → plain body.
 * hljs highlight() throws on unknown languages — getLanguage gate + try/catch
 * keep this total. */
export function highlightCode(lang: string, code: string): StyledRun[][] {
  const language = (lang ?? "").toLowerCase().trim()
  if (language === "" || hljs.getLanguage(language) === undefined) {
    return plainCodeRows(code)
  }
  let html: string
  try {
    html = hljs.highlight(code, { language }).value
  } catch {
    return plainCodeRows(code)
  }
  if (html === "") return []
  return runsFromHtml(html)
}
