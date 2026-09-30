import { memo, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowDown, Brain, X } from "lucide-react"
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

function RowView({ row, open, toggle, page, setPage, navigation, onPreview }: { row: WorkItem; open: Map<string, boolean>; toggle(id: string): void; page: number; setPage(page: number): void; navigation?: FileNavigation; onPreview(preview: { src: string; name: string }): void }) {
  const t = useText()
  if (row.kind === "work-stage") { const expanded = open.get(row.id) ?? row.active; return <button type="button" className="work-stage-heading" aria-expanded={expanded} onClick={() => toggle(row.id)}>{t("工作過程")}<ChevronRight size={14} className={expanded ? "rotate-90" : ""} /></button> }
  if (row.kind === "activity-group") return <ActivityGroup row={row} page={page} setPage={setPage} expanded={open.get(row.id) ?? row.rows.some((tool) => open.get(tool.id) === true)} isOpen={(id) => open.get(id) === true} toggle={toggle} navigation={navigation} />
  if (row.kind === "message") {
    return <div className={`timeline-message timeline-${row.role}`}>
      {row.role === "assistant" ? <MarkdownMessage text={row.text} /> : row.text}
      {row.role === "user" && row.images?.length ? <div className="timeline-user-images">{row.images.map((item, index) => {
        const name = item.name || `${t("圖片")} ${index + 1}`
        const src = `data:${item.mediaType};base64,${item.dataBase64}`
        return <button key={index} type="button" className="timeline-image-button" aria-label={name} title={name} onClick={() => onPreview({ src, name })}>
          <img src={src} alt={name} loading="lazy" decoding="async" />
        </button>
      })}</div> : null}
    </div>
  }
  if (row.kind === "outcome") {
    return <p className="timeline-outcome">{outcomeLabel(row.flags, t)}</p>
  }
  if (row.kind === "other") {
    const expanded = open.get(row.id) ?? (row.label === "reasoning" && row.transient === true)
    return row.detail ? <details className={`timeline-other muted${row.label === "reasoning" ? " timeline-reasoning" : ""}`} open={expanded} onToggle={(event) => { if (event.currentTarget.open !== expanded) toggle(row.id) }}><summary>{row.label === "reasoning" ? <Brain size={14} aria-hidden="true" /> : null}{activityLabel(row.label, t)}</summary>{row.label === "reasoning" ? <div className="timeline-reasoning-body"><MarkdownMessage text={row.detail} /></div> : <pre className="tool-output">{row.detail}</pre>}</details> : <p className="timeline-other muted">{activityLabel(row.label, t)}</p>
  }
  return <ToolActivity name={row.name} args={row.args} output={row.output} resultReceived={row.resultReceived} isError={row.isError} expanded={open.get(row.id) === true} onToggle={() => toggle(row.id)} navigation={navigation} />
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export function Timeline({ rows, navigation, running = false }: { rows: TimelineRow[]; navigation?: FileNavigation; running?: boolean }) {
  const t = useText()
  const [preview, setPreview] = useState<{ src: string; name: string }>()
  useEffect(() => {
    if (!preview) return
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(undefined) }
    document.addEventListener("keydown", dismiss)
    return () => document.removeEventListener("keydown", dismiss)
  }, [preview])
  const grouped = useMemo(() => groupActivities(rows), [rows])
  const [open, setOpen] = useState(new Map<string, boolean>())
  const items = useMemo(() => workStages(grouped, open, running), [grouped, open, running])
  const [pages, setPages] = useState(new Map<string, number>())
  const toggle = (id: string) => {
    following.current = false
    setShowLatest(true)
    setOpen((previous) => {
    const next = new Map(previous)
    const group = items.find((item) => item.id === id)
    const current = previous.get(id) ?? (group?.kind === "work-stage" ? group.active : group?.kind === "other" ? group.label === "reasoning" && group.transient === true : (group?.kind === "activity-group" && group.rows.some((tool) => previous.get(tool.id) === true)))
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
              <RowView row={row} open={open} toggle={toggle} navigation={navigation} onPreview={setPreview} page={pages.get(row.id) ?? 0} setPage={(page) => {
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
    {preview ? createPortal(<div className="timeline-image-overlay" role="dialog" aria-modal="true" aria-label={preview.name}>
      <button type="button" className="timeline-image-close icon-button" aria-label={t("關閉")} onClick={() => setPreview(undefined)}><X size={18} /></button>
      <img src={preview.src} alt={preview.name} />
    </div>, document.body) : null}
    </div>
  )
}
