/* SPDX-License-Identifier: MIT
 * IH Code Mode adapter using the DSH-derived bounded block and raw disclosure
 * patterns documented in TOOL_OUTPUT_SOURCES.md. It consumes durable records;
 * opening the activity does not execute or restore a code cell.
 */
import { useState } from "react"
import { Braces, FileOutput, Save } from "lucide-react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import type { RecordedCodeEvent } from "./project.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { CapturedValueBlock, RawRecordedRecord } from "./RawRecordedData.tsx"
import { RecordedImages } from "./RecordedToolOutput.tsx"
import { record, resultImages } from "./tool-presentation.ts"
import { useToolText } from "./tool-text.ts"
import "./tool-output.css"

export interface RecordedCodeActivityProps {
  event: RecordedCodeEvent
  expanded?: boolean
  onToggle?(): void
  onPreview?(preview: { src: string; name: string }): void
}

const states = { started: ["已開始", "Started"], running: ["執行中", "Running"], completed: ["已完成", "Completed"], failed: ["執行失敗", "Failed"], terminated: ["已停止", "Terminated"], interrupted: ["已中斷", "Interrupted"] } satisfies Record<string, [string, string]>

/** A single historical output item is sufficient; earlier cell data is optional. */
export function RecordedCodeActivity({ event, expanded: controlled, onToggle, onPreview }: RecordedCodeActivityProps) {
  const t = useToolText(), [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
  const title = event.type === "code/output" ? t("Code Mode 輸出", "Code Mode output") : event.type === "code/store" ? t("Code Mode 儲存候選", "Code Mode store candidate") : t("Code Mode 執行單元", "Code Mode cell")
  const Icon = event.type === "code/output" ? FileOutput : event.type === "code/store" ? Save : Braces
  const status = event.type === "code/cell" ? t(...states[event.state]) : t("已記錄", "Recorded")
  return <div className="timeline-other recorded-code-activity">
    <ToolSummaryRow name="Code Mode" title={title} summary={event.cellId} status={status} state={event.type === "code/cell" ? event.state : undefined} icon={<Icon size={15} aria-hidden="true" />} expanded={expanded} label={`${title} ${event.cellId}`} onToggle={onToggle ?? (() => setExpanded(value => !value))} />
    {expanded ? <div className="recorded-code-content"><CodeActivityBody event={event} onPreview={onPreview} /><RawRecordedRecord value={event} /></div> : null}
  </div>
}

/** Typed content is recognized and formatted only after the disclosure opens. */
function CodeActivityBody({ event, onPreview }: Pick<RecordedCodeActivityProps, "event" | "onPreview">) {
  const t = useToolText()
  if (event.type === "code/cell") return <>
    {event.parentCallId || event.sessionId ? <div className="tool-result-metadata">{event.parentCallId ? <span>{t("父呼叫", "Parent call")} <code>{event.parentCallId}</code></span> : null}{event.sessionId ? <span>{t("會話", "Session")} <code>{event.sessionId}</code></span> : null}</div> : null}
    {event.source !== undefined ? <OutputBlock label={t("JavaScript 原始碼", "JavaScript source")} text={event.source} language="javascript" /> : null}
    {event.error !== undefined ? <OutputBlock label={t("錯誤記錄", "Recorded error")} text={event.error} defaultWrap /> : null}
  </>
  if (event.type === "code/store") return <><p className="tool-result-note">{t("此記錄包含儲存候選資料。", "This record contains candidate store values.")}</p><CapturedValueBlock label={t("儲存候選資料", "Candidate store values")} value={event.writes} /></>
  const content = record(event.content)
  if (content?.type === "text" && typeof content.text === "string") return <OutputBlock label={t("Code Mode 輸出", "Code Mode output")} text={content.text} />
  if (content?.type === "image") {
    const output = { images: [content.image] }
    if (resultImages(output).length) return <RecordedImages output={output} onPreview={onPreview} />
  }
  if (content?.type === "audio" && typeof content.audioUrl === "string") {
    // The actual Code Mode contract emits base64 audio data URLs. A record
    // outside that contract remains inspectable data and never starts a fetch.
    const match = /^data:(audio\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(content.audioUrl)
    if (match) {
      const bytes = Math.floor(match[2]!.length * 3 / 4) - (match[2]!.match(/=+$/)?.[0].length ?? 0)
      return <div className="recorded-code-audio"><p className="tool-result-note">{match[1]} · {bytes} bytes</p><audio controls preload="none" src={content.audioUrl} aria-label={t("Code Mode 音訊", "Code Mode audio")} /></div>
    }
  }
  return <CapturedValueBlock label={t("Code Mode 輸出", "Code Mode output")} value={event.content} />
}
