import { useEffect, useRef } from "react"
import type { ProjectFileNavigation } from "../session/file-navigation.ts"
import type { SearchPreview as PreviewValue } from "./content-search-results.ts"
import { SearchText } from "./SearchText.tsx"
import { useProjectFilesText } from "./project-files-text.ts"

export function SearchPreview({ value, navigation }: { value: PreviewValue; navigation?: ProjectFileNavigation }) {
  const pf = useProjectFilesText(), row = useRef<HTMLDivElement>(null), revealed = useRef<string | undefined>(undefined)
  const normalized = value.text.replaceAll("\r\n", "\n")
  const lines = (value.startLine === 1 ? normalized.replace(/^\uFEFF/, "") : normalized).split("\n")
  const lastLine = value.startLine + lines.length - 1
  const targetLine = navigation ? Math.max(value.startLine, Math.min(lastLine, navigation.line)) : value.startLine
  useEffect(() => {
    if (!navigation || revealed.current === navigation.nonce || !row.current) return
    revealed.current = navigation.nonce
    row.current.focus({ preventScroll: true }); row.current.scrollIntoView?.({ block: "center" })
  }, [navigation?.nonce, value])
  return <section className="search-preview" aria-label={pf("唯讀搜尋預覽")}>
    <p className="row-meta">{pf("唯讀搜尋預覽")} · {value.encoding} · {value.startLine}–{lastLine}</p>
    {value.external ? <p className="notice">{pf("專案外檔案僅供唯讀。")}</p> : null}
    {value.changedSinceSearch ? <p className="notice">{pf("檔案已在搜尋後變更；標示位置可能不同。")}</p> : null}
    {value.truncated ? <p className="notice">{pf("僅顯示有界預覽視窗；無法儲存。")}</p> : null}
    {value.reason ? <p className="notice">{value.reason}</p> : null}
    {navigation && targetLine !== navigation.line ? <p className="notice">{pf("搜尋行未在此預覽視窗中；已顯示最近可讀取位置。")}</p> : null}
    <div className="search-preview-lines" tabIndex={0}>
      {lines.map((text, index) => {
        const line = value.startLine + index
        const selected = !!navigation && line >= navigation.line && line <= (navigation.endLine ?? navigation.line)
        return <div key={line} className={`search-preview-line${line === targetLine ? " search-preview-target" : ""}`} ref={line === targetLine ? row : undefined} tabIndex={line === targetLine ? -1 : undefined}>
          <span className="search-preview-gutter" aria-hidden="true">{line}</span>
          <pre><SearchText text={text} startLine={line} target={selected ? { line, column: line === navigation.line ? navigation.column : 0, endLine: line, endColumn: line === (navigation.endLine ?? navigation.line) ? navigation.endColumn : text.length } : undefined} /></pre>
        </div>
      })}
    </div>
  </section>
}
