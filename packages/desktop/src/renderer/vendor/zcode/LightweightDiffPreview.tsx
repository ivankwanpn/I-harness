/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 components/ui/lightweight-diff-preview.tsx.
 * Modified: accepts raw unified diff, keeps metadata neutral and protocol markers
 * visible, omits synthetic line numbers and ZCode settings/i18n dependencies.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { parseUnifiedDiff } from "../../review/unified-diff.ts"
import { useText } from "../../design/i18n.ts"

// Adapted from lib/patchDiffPreview.ts's bounded head/tail fallback (800 rows).
const MAX_RENDER_LINES = 800

export function LightweightDiffPreview({ text }: { text: string }) {
  const t = useText()
  const lines = useMemo(() => parseUnifiedDiff(text), [text])
  const [page, setPage] = useState<number>()
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { setPage(undefined) }, [text])
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0 }, [page, text])
  const paged = lines.length > MAX_RENDER_LINES
  const pageCount = Math.ceil(lines.length / MAX_RENDER_LINES)
  const currentPage = Math.min(page ?? 0, pageCount - 1)
  const visible = !paged ? lines : page !== undefined ? lines.slice(currentPage * MAX_RENDER_LINES, (currentPage + 1) * MAX_RENDER_LINES)
    : [...lines.slice(0, 400), { omitted: lines.length - 799 }, ...lines.slice(-399)]
  return <div>
    {paged ? <div className="diff-pagination">
      {page === undefined ? <button type="button" className="link-button" onClick={() => setPage(0)}>{t("逐段瀏覽差異")}</button> : <>
        <button type="button" className="primary-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("上一段")}</button>
        <span>{currentPage + 1} / {pageCount}</span>
        <button type="button" className="primary-button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一段")}</button>
        <button type="button" className="link-button" onClick={() => setPage(undefined)}>{t("回到差異摘要")}</button>
      </>}
    </div> : null}
    <div ref={scroller} className="zc-diff w-full min-w-0 overflow-auto bg-background" data-lightweight-diff-preview>
    <div className="min-w-full w-max font-mono leading-relaxed text-foreground" style={{ fontSize: 12 }}>
      {visible.map((row, index) => {
        if ("omitted" in row) return <p key={index} className="notice">{t("預覽略去中間 {count} 列；可逐段瀏覽。", { count: row.omitted })}</p>
        const { line, kind, oldLine, newLine } = row
        const color = kind === "added" ? "var(--color-diff-added)" : "var(--color-diff-removed)"
        return <div className="flex min-w-full w-full" key={index} style={kind === "context" ? undefined : {
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          boxShadow: `inset 3px 0 0 ${color}`,
        }}><span className="zc-diff-gutter" aria-hidden="true"><span>{oldLine ?? ""}</span><span>{newLine ?? ""}</span></span><code className="block flex-1 px-3 whitespace-pre">{line || " "}</code></div>
      })}
    </div>
  </div></div>
}
