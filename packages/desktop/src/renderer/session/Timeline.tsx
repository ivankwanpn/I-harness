import { useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { outcomeLabel, type TimelineRow } from "./project.ts"

const COLLAPSED_OUTPUT_CHARS = 2000

function stringify(output: unknown): string {
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function RowView({ row }: { row: TimelineRow }) {
  const [expanded, setExpanded] = useState(false)
  if (row.kind === "message") {
    return <p className={`timeline-message timeline-${row.role}`}>{row.text}</p>
  }
  if (row.kind === "outcome") {
    return <p className="timeline-outcome">{outcomeLabel(row.flags)}</p>
  }
  if (row.kind === "other") {
    return <p className="timeline-other muted">{row.label}</p>
  }
  const text = row.output === undefined ? undefined : stringify(row.output)
  const long = text !== undefined && text.length > COLLAPSED_OUTPUT_CHARS
  return (
    <div className="timeline-tool">
      <span className="row-label">工具：{row.name}</span>
      {row.output === undefined
        ? <span className="muted">尚未回報結果</span>
        : long
          ? (
            <span>
              <button type="button" className="link-button" onClick={() => setExpanded((current) => !current)}>
                {expanded ? "收合輸出" : `展開輸出（${text!.length} 字元）`}
              </button>
              {expanded ? <pre className="tool-output">{text}</pre> : null}
            </span>
          )
          : <pre className="tool-output">{text}</pre>}
    </div>
  )
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export function Timeline({ rows }: { rows: TimelineRow[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
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
