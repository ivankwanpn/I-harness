/* SPDX-License-Identifier: MIT
 * Toolbar, bounded preview and copy feedback patterns adapted from DSH
 * 0.2.0-rc.2 ui-primitives TerminalBlock, CodeBlock and use-copy-feedback.
 * React/clipboard handling, pagination and IH tokens are local adaptations.
 * See TOOL_OUTPUT_SOURCES.md for sources and hashes.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, ChevronUp, Copy, WrapText } from "lucide-react"
import { Button } from "../vendor/opencode/Button.tsx"
import { useToolText } from "./tool-text.ts"
import { useOutputCopy } from "./useOutputCopy.ts"
import "./tool-output.css"

export interface OutputBlockProps {
  label: string
  text: string
  language?: string
  truncated?: boolean
  className?: string
  defaultWrap?: boolean
  getCopyText?(): string
}

const PAGE_CHARS = 16000
const PREVIEW_CHARS = 4000
const PREVIEW_LINES = 24
function characterBoundary(text: string, offset: number): number {
  const index = Math.min(offset, text.length)
  const current = text.charCodeAt(index), previous = text.charCodeAt(index - 1)
  return current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index
}

/** Bounded DOM with explicit section browsing; copy always uses the capture. */
export function OutputBlock({ label, text, language, truncated, className = "", defaultWrap = false, getCopyText }: OutputBlockProps) {
  const t = useToolText()
  const id = useId()
  const [wrap, setWrap] = useState(defaultWrap)
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(0)
  const { state: copyState, error: copyError, copy } = useOutputCopy(text, getCopyText)
  const scroller = useRef<HTMLPreElement>(null)
  useEffect(() => { setPage(0) }, [text])
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0 }, [page, expanded])
  const preview = useMemo(() => {
    const head = text.slice(0, characterBoundary(text, PREVIEW_CHARS))
    let end = head.length, lines = 0
    for (let i = 0; i < head.length; i++) if (head[i] === "\n" && ++lines === PREVIEW_LINES) { end = i; break }
    return head.slice(0, end)
  }, [text])
  const clipped = preview.length < text.length
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS))
  const currentPage = Math.min(page, pages - 1)
  const visible = expanded ? text.slice(characterBoundary(text, currentPage * PAGE_CHARS), characterBoundary(text, (currentPage + 1) * PAGE_CHARS)) : preview
  const copyLabel = copyState === "copied" ? t("已複製", "Copied") : copyState === "pending" ? t("正在複製", "Copying") : t("複製", "Copy")
  return <section className={`output-block ${className}`} aria-label={label}>
    <div className="output-block-toolbar">
      <span className="output-block-label">{label}</span>
      {language ? <span className="output-block-language">{language}</span> : null}
      <div className="output-block-actions">
        <Button variant="ghost" size="small" icon={<WrapText size={14} />} aria-label={`${t("自動換行", "Wrap lines")} ${label}`} aria-pressed={wrap} onClick={() => setWrap(value => !value)}>{t("換行", "Wrap")}</Button>
        {clipped ? <Button variant="ghost" size="small" icon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} aria-label={`${expanded ? t("收合", "Collapse") : t("展開", "Expand")} ${label}`} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? t("收合", "Collapse") : t("展開", "Expand")}</Button> : null}
        <Button variant="ghost" size="small" icon={copyState === "copied" ? <Check size={14} /> : <Copy size={14} />} disabled={copyState === "pending"} aria-busy={copyState === "pending"} aria-label={`${copyLabel} ${label}`} onClick={() => { void copy() }}>{copyLabel}</Button>
      </div>
    </div>
    {truncated ? <p className="output-block-notice">{t("記錄的輸出已截斷", "The recorded output is truncated")}</p> : null}
    <pre ref={scroller} id={id} className={`output-block-content${wrap ? " output-block-wrap" : ""}${expanded ? " output-block-expanded" : ""}`} tabIndex={0}><code>{visible || t("沒有文字輸出", "No text output")}</code></pre>
    {clipped && !expanded ? <p className="output-block-notice">{t("預覽僅顯示部分記錄；展開可逐段瀏覽。", "Preview shows part of the capture; expand to browse every section.")}</p> : null}
    {expanded && pages > 1 ? <div className="output-block-pagination">
      <Button variant="ghost" size="small" disabled={currentPage === 0} aria-label={`${t("上一段", "Previous section")} ${label}`} onClick={() => setPage(currentPage - 1)}>{t("上一段", "Previous")}</Button>
      <span aria-live="polite">{currentPage + 1} / {pages}</span>
      <Button variant="ghost" size="small" disabled={currentPage + 1 === pages} aria-label={`${t("下一段", "Next section")} ${label}`} onClick={() => setPage(currentPage + 1)}>{t("下一段", "Next")}</Button>
    </div> : null}
    {copyError ? <p role="alert" className="output-block-error">{copyError}</p> : null}
  </section>
}
