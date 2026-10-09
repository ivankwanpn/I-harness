import { useState } from "react"
import { Braces, FileSearch, FileText, Globe, PencilLine, Plug, Terminal, Wrench } from "lucide-react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { useText } from "../design/i18n.ts"
import type { FileNavigation } from "./file-navigation.ts"
import type { ToolResultReference } from "./project.ts"
import { RecordedFileLink } from "./RecordedFileLink.tsx"
import { RecordedToolOutput } from "./RecordedToolOutput.tsx"
import { toolFamily, toolState, toolSummary, type ToolFamily, type ToolState } from "./tool-presentation.ts"
import { useToolText } from "./tool-text.ts"
import "./tool-output.css"

const icons = { command: Terminal, read: FileText, write: PencilLine, search: FileSearch, web: Globe, code: Braces, mcp: Plug, other: Wrench }
const titles: Record<ToolFamily, [string, string]> = { command: ["終端", "Terminal"], read: ["讀取", "Read"], write: ["檔案變更", "File changes"], search: ["搜尋", "Search"], web: ["網頁", "Web"], code: ["Code Mode", "Code Mode"], mcp: ["MCP", "MCP"], other: ["工具", "Tool"] }
const statuses: Record<ToolState, [string, string]> = { pending: ["尚未回報結果", "No result recorded yet"], dispatched: ["已派發，等待結果", "Dispatched, awaiting result"], received: ["已收到結果", "Result received"], running: ["執行中", "Running"], failed: ["執行失敗", "Failed"], cancelled: ["已取消", "Cancelled"], stopped: ["已停止", "Stopped"], interrupted: ["已中斷", "Interrupted"] }

export interface ToolActivityProps {
  name: string
  args?: unknown
  output?: unknown
  resultReceived?: true
  isError?: true
  dispatched?: true
  cellId?: string
  parentCallId?: string
  resultRefs?: ToolResultReference[]
  expanded?: boolean
  onToggle?(): void
  navigation?: FileNavigation
  onPreview?(preview: { src: string; name: string }): void
}

/** Read-only presentation of captured calls. Opening a card never runs a tool. */
export function ToolActivity({ name, args, output, resultReceived, isError, dispatched, cellId, parentCallId, resultRefs, expanded: controlled, onToggle, navigation, onPreview }: ToolActivityProps) {
  const t = useText(), tt = useToolText()
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
  const family = toolFamily(name), state = toolState(name, output, resultReceived, isError, dispatched), Icon = icons[family]
  const summary = toolSummary(name, args, output) ?? (family === "other" || family === "mcp" ? name : undefined)
  return <div className="tool-activity tool-activity-recorded" data-tool-family={family} data-tool-state={state}>
    <div className="tool-activity-heading">
      <ToolSummaryRow name={name} title={tt(...titles[family])} summary={summary} status={tt(...statuses[state])} icon={<Icon size={15} aria-hidden="true" />} state={state}
        label={`${t("工具詳情")} ${name}`} expanded={expanded} onToggle={onToggle ?? (() => setExpanded(value => !value))} />
      <RecordedFileLink name={name} args={args} navigation={navigation} compact />
    </div>
    {expanded ? <div className="tool-expanded-content">
      {cellId || parentCallId ? <div className="tool-result-metadata">{cellId ? <span>{tt("執行單元", "Cell")} <code>{cellId}</code></span> : null}{parentCallId ? <span>{tt("父呼叫", "Parent call")} <code>{parentCallId}</code></span> : null}</div> : null}
      <RecordedToolOutput name={name} args={args} output={output} resultReceived={resultReceived} navigation={navigation} resultRefs={resultRefs} onPreview={onPreview} />
    </div> : null}
  </div>
}
