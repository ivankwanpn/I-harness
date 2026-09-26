import { memo, useEffect, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { outcomeLabel, type TimelineRow } from "./project.ts"
import { ToolActivity } from "./ToolActivity.tsx"
import { useText } from "../design/i18n.ts"

const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  const t = useText()
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ alt }) => <span className="muted">[{t("圖片")}: {alt}]</span>,
  }}>{text}</Markdown>
})

function RowView({ row }: { row: TimelineRow }) {
  const t = useText()
  if (row.kind === "message") {
    return <div className={`timeline-message timeline-${row.role}`}>
      {row.role === "assistant" ? <MarkdownMessage text={row.text} /> : row.text}
    </div>
  }
  if (row.kind === "outcome") {
    return <p className="timeline-outcome">{outcomeLabel(row.flags, t)}</p>
  }
  if (row.kind === "other") {
    return <p className="timeline-other muted">{row.label}</p>
  }
  return <ToolActivity name={row.name} output={row.output} />
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export function Timeline({ rows }: { rows: TimelineRow[] }) {
  const t = useText()
  const parentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rows[index]!.id,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
    // Seed the first measurement so rows mount before any observer fires.
    initialRect: { width: 1024, height: 768 },
  })
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    if (!following.current || rows.length === 0) return
    const frame = requestAnimationFrame(() => {
      if (following.current) virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
    })
    return () => cancelAnimationFrame(frame)
  }, [rows, totalSize, virtualizer])
  return (
    <div className="timeline-region">
    <div ref={parentRef} className="timeline" data-testid="timeline" tabIndex={0} aria-label={t("會話內容")}
      onScroll={() => {
        const element = parentRef.current
        if (!element) return
        const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 48
        following.current = atBottom
        setShowLatest(!atBottom)
      }}>
      <div className="timeline-inner" style={{ height: `${totalSize}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!
          return (
            <div
              key={row.id}
              className="timeline-row"
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <RowView row={row} />
            </div>
          )
        })}
      </div>
    </div>
    {showLatest && rows.length > 0 ? <button type="button" className="timeline-latest" onClick={() => {
      following.current = true; setShowLatest(false); virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
    }}><ArrowDown size={14} />{t("回到最新內容")}</button> : null}
    </div>
  )
}
