import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { outcomeLabel, type TimelineRow } from "./project.ts"
import { ToolActivity } from "./ToolActivity.tsx"

function RowView({ row }: { row: TimelineRow }) {
  if (row.kind === "message") {
    return <div className={`timeline-message timeline-${row.role}`}>
      {row.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]} components={{
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        img: ({ alt }) => <span className="muted">[圖片：{alt}]</span>,
      }}>{row.text}</Markdown> : row.text}
    </div>
  }
  if (row.kind === "outcome") {
    return <p className="timeline-outcome">{outcomeLabel(row.flags)}</p>
  }
  if (row.kind === "other") {
    return <p className="timeline-other muted">{row.label}</p>
  }
  return <ToolActivity name={row.name} output={row.output} />
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export function Timeline({ rows }: { rows: TimelineRow[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rows[index]!.id,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
    // Seed the first measurement so rows mount before any observer fires.
    initialRect: { width: 1024, height: 768 },
  })
  return (
    <div ref={parentRef} className="timeline" data-testid="timeline">
      <div className="timeline-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
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
  )
}
