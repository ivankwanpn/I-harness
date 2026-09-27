import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { activityLabel, outcomeLabel, type TimelineRow } from "./project.ts"
import { ToolActivity } from "./ToolActivity.tsx"
import { ActivityGroup } from "./ActivityGroup.tsx"
import { groupActivities } from "./activity-groups.ts"
import { workStages, type WorkItem } from "./work-stages.ts"
import { ChevronRight } from "lucide-react"
import { useText } from "../design/i18n.ts"
import type { FileNavigation } from "./file-navigation.ts"

const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  const t = useText()
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ alt }) => <span className="muted">[{t("圖片")}: {alt}]</span>,
  }}>{text}</Markdown>
})

function RowView({ row, open, toggle, page, setPage, navigation }: { row: WorkItem; open: Map<string, boolean>; toggle(id: string): void; page: number; setPage(page: number): void; navigation?: FileNavigation }) {
  const t = useText()
  if (row.kind === "work-stage") return <button type="button" className="work-stage-heading" aria-expanded={open.get(row.id) !== false} onClick={() => toggle(row.id)}>{t("工作過程")}<ChevronRight size={14} className={open.get(row.id) !== false ? "rotate-90" : ""} /></button>
  if (row.kind === "activity-group") return <ActivityGroup row={row} page={page} setPage={setPage} expanded={open.get(row.id) ?? row.rows.some((tool) => open.get(tool.id) === true)} isOpen={(id) => open.get(id) === true} toggle={toggle} navigation={navigation} />
  if (row.kind === "message") {
    return <div className={`timeline-message timeline-${row.role}`}>
      {row.role === "assistant" ? <MarkdownMessage text={row.text} /> : row.text}
    </div>
  }
  if (row.kind === "outcome") {
    return <p className="timeline-outcome">{outcomeLabel(row.flags, t)}</p>
  }
  if (row.kind === "other") {
    return row.detail ? <details className="timeline-other muted" open={open.get(row.id) === true} onToggle={(event) => { if (event.currentTarget.open !== (open.get(row.id) === true)) toggle(row.id) }}><summary>{activityLabel(row.label, t)}</summary><pre className="tool-output">{row.detail}</pre></details> : <p className="timeline-other muted">{activityLabel(row.label, t)}</p>
  }
  return <ToolActivity name={row.name} args={row.args} output={row.output} expanded={open.get(row.id) === true} onToggle={() => toggle(row.id)} navigation={navigation} />
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export function Timeline({ rows, navigation }: { rows: TimelineRow[]; navigation?: FileNavigation }) {
  const t = useText()
  const grouped = useMemo(() => groupActivities(rows), [rows])
  const [open, setOpen] = useState(new Map<string, boolean>())
  const items = useMemo(() => workStages(grouped, open), [grouped, open])
  const [pages, setPages] = useState(new Map<string, number>())
  const toggle = (id: string) => {
    following.current = false
    setShowLatest(true)
    setOpen((previous) => {
    const next = new Map(previous)
    const group = items.find((item) => item.id === id)
    const current = previous.get(id) ?? (group?.kind === "work-stage" || (group?.kind === "activity-group" && group.rows.some((tool) => previous.get(tool.id) === true)))
    next.set(id, !current)
    if (next.size > 2000) next.delete(next.keys().next().value!)
    return next
    })
  }
  const parentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey: (index) => items[index]!.id,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
    // Seed the first measurement so rows mount before any observer fires.
    initialRect: { width: 1024, height: 768 },
  })
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    if (!following.current || items.length === 0) return
    const frame = requestAnimationFrame(() => {
      if (following.current) virtualizer.scrollToIndex(items.length - 1, { align: "end" })
    })
    return () => cancelAnimationFrame(frame)
  }, [items, totalSize, virtualizer])
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
          const row = items[item.index]!
          return (
            <div
              key={row.id}
              className="timeline-row"
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <RowView row={row} open={open} toggle={toggle} navigation={navigation} page={pages.get(row.id) ?? 0} setPage={(page) => {
                following.current = false; setShowLatest(true)
                setPages((previous) => {
                const next = new Map(previous); next.set(row.id, page)
                if (next.size > 2000) next.delete(next.keys().next().value!)
                return next
                })
              }} />
            </div>
          )
        })}
      </div>
    </div>
    {showLatest && rows.length > 0 ? <button type="button" className="timeline-latest" onClick={() => {
      following.current = true; setShowLatest(false); virtualizer.scrollToIndex(items.length - 1, { align: "end" })
    }}><ArrowDown size={14} />{t("回到最新內容")}</button> : null}
    </div>
  )
}
