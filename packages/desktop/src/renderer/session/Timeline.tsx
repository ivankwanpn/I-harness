import { Children, isValidElement, memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, Brain, ChevronRight, CircleAlert } from "lucide-react"
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { activityLabel, outcomeLabel, type TimelineRow } from "./project.ts"
import type { RecordedResultReader } from "./result-pages.ts"
import { ToolActivity } from "./ToolActivity.tsx"
import { ActivityGroup } from "./ActivityGroup.tsx"
import { groupActivities } from "./activity-groups.ts"
import { workStages, type WorkItem } from "./work-stages.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { displayError } from "../design/error-display.ts"
import type { FileNavigation } from "./file-navigation.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { RecordedCodeActivity } from "./RecordedCodeActivity.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { GenerationSpeed, MessageActions } from "./MessageActions.tsx"
import { useToolText } from "./tool-text.ts"
import type { AssistantPreview } from "./event-window.ts"
import type { HistoryScroll } from "./use-history-scroll.ts"
import { reasoningPreview } from "./reasoning-progress.ts"
import "./timeline-polish.css"

const MarkdownMessage = memo(function MarkdownMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const t = useText()
  const toolText = useToolText()
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ alt }) => <span className="muted">[{t("圖片")}: {alt}]</span>,
    pre: ({children}) => {
      if (streaming) return <pre>{children}</pre>
      const code = Children.toArray(children).find(child => isValidElement<{children?:ReactNode;className?:string}>(child))
      if (!isValidElement<{children?:ReactNode;className?:string}>(code) || typeof code.props.children !== "string") return <pre>{children}</pre>
      const language = code.props.className?.match(/language-([^\s]+)/)?.[1]
      return <OutputBlock label={toolText("程式碼","Code")} text={code.props.children} language={language} className="timeline-code" />
    },
  }}>{text}</Markdown>
})

function StreamingMarkdownMessage({ text }: { text: string }) {
  return <MarkdownMessage text={useDeferredValue(text)} streaming />
}

function ReasoningRow({ label, text, streaming, expanded, onToggle }: { label: string; text: string; streaming: boolean; expanded: boolean; onToggle(): boolean }) {
  const tt = useToolText()
  const bodyId = useId()
  const textForRender = useDeferredValue(text)
  const body = useRef<HTMLDivElement>(null)
  const revealOnOpen = useRef(false)
  const summary = streaming && !expanded ? reasoningPreview(textForRender) : undefined
  const heading = streaming ? tt("思考中…", "Thinking…") : label

  useLayoutEffect(() => {
    if (!expanded || !revealOnOpen.current) return
    revealOnOpen.current = false
    body.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [expanded])

  return <div className="timeline-reasoning" data-streaming={streaming || undefined}>
    <button type="button" className="timeline-reasoning-trigger" aria-expanded={expanded} aria-controls={bodyId} onClick={() => {
      const keepFollowing = onToggle()
      if (!expanded) revealOnOpen.current = !keepFollowing
    }}>
      <Brain size={14} aria-hidden="true" />
      <span className="timeline-reasoning-label">{heading}</span>
      {summary ? <span className="timeline-reasoning-preview" aria-hidden="true">{summary}</span> : null}
      <ChevronRight size={14} className="timeline-reasoning-chevron" aria-hidden="true" />
    </button>
    <div ref={body} id={bodyId} className="timeline-reasoning-body" role="region" aria-label={label} hidden={!expanded}>
      {expanded ? <MarkdownMessage text={streaming ? textForRender : text} streaming={streaming} /> : null}
    </div>
  </div>
}

function RowView({ row, open, toggle, activeReasoningId, page, setPage, navigation, onPreview, resultReader }: { resultReader?: RecordedResultReader; row: WorkItem; open: Map<string, boolean>; toggle(id: string, expanded?: boolean): boolean; activeReasoningId?: string; page: number; setPage(page: number): void; navigation?: FileNavigation; onPreview(preview: { src: string; name: string }): void }) {
  const t = useText()
  const toolText = useToolText()
  const english = useLocale(state => state.locale) === "en"
  if (row.kind === "work-stage") {
    const count = `${row.count} ${toolText("項活動",row.count===1?"activity":"activities")}`
    const note = row.hasErrors ? toolText("部分活動未完成","Some activities were not completed") : undefined
    return <button type="button" className="work-stage-heading" aria-label={t("工作過程")} aria-description={`${count}${note?` · ${note}`:""}`} aria-expanded={row.expanded} onClick={() => toggle(row.id)}>{t("工作過程")}<span className="work-stage-meta">{count}{note?<span className="work-stage-incomplete">{note}</span>:null}{row.generation ? <GenerationSpeed generation={row.generation} /> : null}</span><ChevronRight size={14} className={row.expanded ? "rotate-90" : ""} /></button>
  }
  if (row.kind === "activity-group") return <ActivityGroup resultReader={resultReader} row={row} page={page} setPage={setPage} expanded={open.get(row.id) ?? row.rows.some((tool) => open.get(tool.id) === true)} isOpen={(id) => open.get(id) === true} toggle={toggle} navigation={navigation} onPreview={onPreview} />
  if (row.kind === "message") {
    return <div className={`timeline-message timeline-${row.role}`}>
      {row.role === "assistant" ? row.transient ? <StreamingMarkdownMessage text={row.text} /> : <>
        {row.interrupted ? <p className="timeline-partial-reply">{toolText("中斷前的回覆", "Response before interruption")}</p> : null}
        <MarkdownMessage text={row.text} /><MessageActions text={row.text} generation={row.generation} />
      </> : row.text}
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
    return <p className="timeline-outcome"><CircleAlert size={16} aria-hidden="true" />{outcomeLabel(row.flags, t)}</p>
  }
  if (row.kind === "failure") {
    const { code, httpStatus } = row.failure
    const summary = displayError(t("模型回應已中斷"), { english, code, httpStatus }).summary
    return <div className="timeline-failure" data-stopped={code === "ABORTED" || undefined}>
      <CircleAlert size={16} aria-hidden="true" />
      <div><strong>{summary}</strong>{typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? <small>HTTP {httpStatus}</small> : null}</div>
    </div>
  }
  if (row.kind === "other") {
    const expanded = open.get(row.id) === true
    if (row.codeActivity) return <RecordedCodeActivity resultReader={resultReader} event={row.codeActivity} expanded={expanded} onToggle={() => toggle(row.id)} onPreview={onPreview} />
    const label = row.title ?? activityLabel(row.label, t)
    if (!row.detail) return <p className="timeline-other muted">{label}</p>
    if (row.label === "reasoning") return <ReasoningRow label={label} text={row.detail} streaming={row.id === activeReasoningId} expanded={expanded} onToggle={() => toggle(row.id, !expanded)} />
    return <details className="timeline-other muted" open={expanded} onToggle={(event) => { if (event.currentTarget.open !== expanded) toggle(row.id, event.currentTarget.open) }}>
      <summary><span>{label}</span></summary>
      {expanded ? <pre className="tool-output">{row.detail}</pre> : null}
    </details>
  }
  return <ToolActivity resultReader={resultReader} name={row.name} args={row.args} output={row.output} envelope={row.envelope} resultReceived={row.resultReceived} isError={row.isError} dispatched={row.dispatched} cellId={row.cellId} parentCallId={row.parentCallId} resultRefs={row.resultRefs} expanded={open.get(row.id) === true} onToggle={() => toggle(row.id)} navigation={navigation} onPreview={onPreview} />
}

/** Only the visible rows are mounted, so a long session stays bounded. */
export interface TimelineProps { resultReader?: RecordedResultReader; rows: TimelineRow[]; assistantPreview?: AssistantPreview; navigation?: FileNavigation; running?: boolean; targetSeq?: number; historical?: boolean; history?: HistoryScroll; onTargetVisible?(seq: number): void }
const HISTORY_EDGE_PX = 96
function timelineKey(row: WorkItem): string {
  return row.kind === "message" && row.stepStartSeq !== undefined ? `assistant:${row.stepStartSeq}` : row.id
}
export function Timeline({ rows, assistantPreview, navigation, running = false, targetSeq, historical = false, history, onTargetVisible, resultReader }: TimelineProps) {
  const t = useText()
  const tt = useToolText()
  const latestTurn = rows.at(-1)?.turn
  const liveGeneration = running && !historical && !latestTurn?.complete ? latestTurn?.generation : undefined
  const activeReasoningId = running && !historical && !assistantPreview
    ? rows.findLast(row => row.kind === "other" && row.label === "reasoning" && row.transient && !row.turn?.complete && (!latestTurn || row.turn?.id === latestTurn.id))?.id
    : undefined
  const [preview, setPreview] = useState<{ src: string; name: string }>()
  const grouped = useMemo(() => groupActivities(rows), [rows])
  const [open, setOpen] = useState(new Map<string, boolean>())
  const items = useMemo(() => workStages(grouped, open), [grouped, open])
  // Streamed body text is a single tail item. A text update leaves the
  // recorded projection, activity groups, and their measurements in place.
  const previewItem: TimelineRow | undefined = assistantPreview && {
    id: `assistant:${assistantPreview.stepStartSeq}`, stepStartSeq: assistantPreview.stepStartSeq,
    kind: "message", role: "assistant", text: assistantPreview.text, transient: true,
  }
  const itemCount = items.length + (previewItem ? 1 : 0)
  const previewStep = assistantPreview?.stepStartSeq
  const itemAt = (index: number): WorkItem => items[index] ?? previewItem!
  const itemKey = useCallback((index: number) => index < items.length
    ? timelineKey(items[index]!) : `assistant:${previewStep}`, [items, previewStep])
  const [pages, setPages] = useState(new Map<string, number>())
  const toggle = (id: string, expanded?: boolean) => {
    const group = items.find((item) => item.id === id)
    const reasoning = group?.kind === "other" && group.label === "reasoning"
    const keepFollowing = (reasoning || group?.kind === "work-stage") && following.current && !historical && targetSeq === undefined
    if (!keepFollowing) pauseFollowing()
    setOpen((previous) => {
      const next = new Map(previous)
      const current = previous.get(id) ?? (group?.kind === "activity-group" && group.rows.some((tool) => previous.get(tool.id) === true))
      next.set(id, expanded ?? !current)
      while (next.size > 2000) next.delete(next.keys().next().value!)
      return next
    })
    return keepFollowing
  }
  const parentRef = useRef<HTMLDivElement>(null)
  const following = useRef(!historical && targetSeq === undefined)
  const followFrame = useRef<number | undefined>(undefined)
  const readingDirection = useRef<"up" | "down">("up")
  const pointerReading = useRef(false)
  const observedScrollTop = useRef(0)
  const touchY = useRef<number | undefined>(undefined)
  const located = useRef<number | undefined>(undefined)
  const [showLatest, setShowLatest] = useState(false)
  const [historyEdges, setHistoryEdges] = useState({ before: false, after: false })
  const historyPaging = history !== undefined
  const wasHistorical = useRef(historical)
  const writeScroll = useCallback<typeof elementScroll>((offset, options, instance) => {
    const element = instance.scrollElement
    const before = element?.scrollTop
    elementScroll(offset, options, instance)
    if (element && before !== undefined) {
      // Remove only the actual programmatic/clamped movement from the next
      // scroll delta, preserving any coalesced native thumb movement.
      observedScrollTop.current += element.scrollTop - before
    }
  }, [])
  const virtualizer = useVirtualizer({
    count: itemCount,
    getItemKey: itemKey,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
    // Resolve the existing row key before the virtualizer renders the new
    // range. Its measurements then keep the same reading offset on prepend.
    anchorTo: history?.viewport ? "end" : "start",
    // Seed the first measurement so rows mount before any observer fires.
    initialRect: { width: 1024, height: 768 },
    scrollToFn: writeScroll,
  })
  const totalSize = virtualizer.getTotalSize()
  const followLatest = useCallback(() => {
    if (!following.current || historical || targetSeq !== undefined) return
    if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current)
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = undefined
      const element = parentRef.current
      if (element && following.current && !historical && targetSeq === undefined) {
        // DOM overflow can exceed the virtual row estimate (Markdown margins,
        // wrapping and delayed media). Pin to the physical scroll extent.
        virtualizer.scrollToOffset(Math.max(0, element.scrollHeight - element.clientHeight))
      }
    })
  }, [virtualizer, historical, targetSeq])
  const pauseFollowing = () => {
    readingDirection.current = "up"
    observedScrollTop.current = parentRef.current?.scrollTop ?? 0
    following.current = false
    setShowLatest(true)
  }
  const updateHistoryEdges = useCallback((element: HTMLDivElement) => {
    if (!historyPaging) return
    const before = element.scrollTop <= HISTORY_EDGE_PX
    const after = element.scrollHeight - element.clientHeight - element.scrollTop <= HISTORY_EDGE_PX
    setHistoryEdges(previous => previous.before === before && previous.after === after ? previous : { before, after })
  }, [historyPaging])
  const requestHistory = (direction: "before" | "after", automatic = true) => {
    if (!history || history.loading || (automatic && history.error)) return
    const load = direction === "before" ? history.earlier : history.later
    const element = parentRef.current
    if (!load || !element) return
    const distance = direction === "before" ? element.scrollTop : element.scrollHeight - element.clientHeight - element.scrollTop
    if (automatic && distance > HISTORY_EDGE_PX) return
    pauseFollowing()
    load()
  }
  useLayoutEffect(() => {
    if (wasHistorical.current && !historical) {
      following.current = true
      setShowLatest(false)
    }
    wasHistorical.current = historical
    if (parentRef.current) updateHistoryEdges(parentRef.current)
  }, [historical, items, updateHistoryEdges])
  const target = rows.find(row => targetSeq !== undefined && row.seqs?.includes(targetSeq))
  const targetGroup = target ? grouped.find(row => row.kind === "activity-group" && row.rows.some(tool => tool.id === target.id)) : undefined
  useEffect(() => {
    if (!target || targetSeq === undefined) return
    following.current = false
    const group = targetGroup
    setOpen(previous => {
      const next = new Map(previous)
      next.set(target.id, true)
      if (target.turn) next.set(`work:${target.turn.id}`, true)
      if (group) next.set(group.id, true)
      return next
    })
    if (group?.kind === "activity-group") setPages(previous => new Map(previous).set(group.id, Math.floor(group.rows.findIndex(tool => tool.id === target.id) / 50)))
  }, [target?.id, target?.turn?.id, targetGroup?.id, targetSeq])
  useEffect(() => {
    if (!target || targetSeq === undefined || located.current === targetSeq) return
    const index = items.findIndex(row => row.id === target.id || (row.kind === "activity-group" && row.rows.some(tool => tool.id === target.id)))
    if (index < 0) return
    const frame = requestAnimationFrame(() => { located.current = targetSeq; virtualizer.scrollToIndex(index, { align: "center" }); onTargetVisible?.(targetSeq) })
    return () => cancelAnimationFrame(frame)
  }, [items, target?.id, targetSeq, virtualizer, onTargetVisible])
  useEffect(() => {
    if (!following.current || itemCount === 0) return
    followLatest()
  }, [items, itemCount, totalSize, followLatest])
  useEffect(() => {
    const element = parentRef.current
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (element) updateHistoryEdges(element)
      followLatest()
    })
    if (element) {
      observer?.observe(element)
      if (element.firstElementChild) observer?.observe(element.firstElementChild)
    }
    const releasePointer = () => {
      if (!pointerReading.current) return
      pointerReading.current = false
      if (element && element.scrollHeight - element.clientHeight - element.scrollTop <= 1 && !historical && targetSeq === undefined) {
        following.current = true
        setShowLatest(false)
        followLatest()
      }
    }
    const cancelPointer = () => { pointerReading.current = false; readingDirection.current = "up" }
    window.addEventListener("pointerup", releasePointer, true)
    window.addEventListener("pointercancel", cancelPointer, true)
    window.addEventListener("blur", cancelPointer)
    return () => {
      observer?.disconnect()
      window.removeEventListener("pointerup", releasePointer, true)
      window.removeEventListener("pointercancel", cancelPointer, true)
      window.removeEventListener("blur", cancelPointer)
      pointerReading.current = false
      if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current)
      followFrame.current = undefined
    }
  }, [followLatest, historical, targetSeq, updateHistoryEdges])
  const canReturnLatest = history?.viewport !== undefined || (!historical && showLatest && itemCount > 0)
  const showEarlier = !!history?.earlier && (historyEdges.before || !!history.error)
  const showLater = !!history?.later && (historyEdges.after || !!history.error)
  return (
    <div className="timeline-region">
    <div ref={parentRef} className="timeline" data-testid="timeline" tabIndex={0} aria-label={t("會話內容")}
      onWheel={event => {
        if (event.deltaY < 0) { pauseFollowing(); requestHistory("before") }
        else if (event.deltaY > 0) { readingDirection.current = "down"; requestHistory("after") }
      }}
      onTouchStart={event => { touchY.current = event.touches[0]?.clientY }}
      onTouchMove={event => {
        const current = event.touches[0]?.clientY
        if (current !== undefined && touchY.current !== undefined && current < touchY.current) readingDirection.current = "down"
        else pauseFollowing()
        touchY.current = current
      }}
      onPointerDown={event => { if (event.target === event.currentTarget) { pointerReading.current = true; pauseFollowing() } }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.shiftKey && event.key === " ") { pauseFollowing(); requestHistory("before") }
        else if (["ArrowDown", "PageDown", "End"].includes(event.key) || !event.shiftKey && event.key === " ") { readingDirection.current = "down"; requestHistory("after") }
      }}
      onScroll={() => {
        const element = parentRef.current
        if (!element) return
        const readerDelta = element.scrollTop - observedScrollTop.current
        observedScrollTop.current = element.scrollTop
        updateHistoryEdges(element)
        // Chromium captures native thumb movement without DOM pointermove.
        // Programmatic virtualizer compensation was removed by writeScroll.
        if (pointerReading.current && Math.abs(readerDelta) > 1) {
          if (readerDelta > 0) readingDirection.current = "down"
          else pauseFollowing()
        }
        const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 1
        // A growing row/viewport resize can fire scroll without reader intent.
        // Only explicit reading gestures pause; scrolling down to the end resumes.
        if (!following.current && readerDelta < -1) requestHistory("before")
        if (historical && readerDelta > 1) requestHistory("after")
        if (following.current) {
          if (!atBottom) followLatest()
        } else if (atBottom && readingDirection.current === "down" && !historical && targetSeq === undefined) {
          following.current = true
          setShowLatest(false)
        }
      }}>
      <div className="timeline-inner" style={{ height: `${totalSize}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = itemAt(item.index)
          return (
            <div
              key={timelineKey(row)}
              className="timeline-row"
              data-row-id={row.id}
              data-row-kind={row.kind}
              data-search-target={row.id === target?.id || (row.kind === "activity-group" && row.rows.some(tool => tool.id === target?.id)) ? "true" : undefined}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)`, ...(row.id === target?.id || (row.kind === "activity-group" && row.rows.some(tool => tool.id === target?.id)) ? { outline: "2px solid var(--accent, #5073c8)", outlineOffset: "-2px" } : {}) }}
            >
              {row.id === target?.id || (row.kind === "activity-group" && row.rows.some(tool => tool.id === target?.id)) ? <span className="muted">搜尋命中</span> : null}
              <RowView resultReader={resultReader} row={row} open={open} toggle={toggle} activeReasoningId={activeReasoningId} navigation={navigation} onPreview={setPreview} page={pages.get(row.id) ?? 0} setPage={(page) => {
                pauseFollowing()
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
    {showEarlier || showLater || history?.loading || history?.error ? <div className="timeline-history-controls">
      {showEarlier ? <button type="button" className="primary-button" disabled={history?.loading} onClick={() => requestHistory("before", false)}>{t("載入較早內容")}</button> : null}
      {showLater ? <button type="button" className="primary-button" disabled={history?.loading} onClick={() => requestHistory("after", false)}>{t("載入較後內容")}</button> : null}
      {history?.loading ? <span role="status">{t("正在載入歷史…")}</span> : null}
      {history?.error ? <span role="alert">{displayError(history.error).summary}</span> : null}
    </div> : null}
    {canReturnLatest || liveGeneration ? <div className="timeline-controls">
      {canReturnLatest ? <button type="button" className="timeline-latest" onClick={() => {
        history?.latest?.()
        following.current = true; setShowLatest(false); followLatest()
      }}><ArrowDown size={14} aria-hidden="true" />{t("回到最新內容")}</button> : null}
      {liveGeneration ? <div className="timeline-activity-speed"><span>{tt("本輪已量測", "This turn so far")}</span><GenerationSpeed generation={liveGeneration} /></div> : null}
    </div> : null}
    {preview ? <SettingsDialog title={preview.name} closeLabel={t("關閉")} initialFocusSelector=".settings-dialog-close" className="timeline-image-dialog" onClose={() => setPreview(undefined)}>
      <img src={preview.src} alt={preview.name} />
    </SettingsDialog> : null}
    </div>
  )
}
