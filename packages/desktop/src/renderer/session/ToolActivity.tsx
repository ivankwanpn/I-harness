import { useMemo, useState } from "react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { useText } from "../design/i18n.ts"
import { toolFilePath, type FileNavigation } from "./file-navigation.ts"

export function ToolActivity({ name, args, output, expanded: controlled, onToggle, navigation }: { name: string; args?: unknown; output?: unknown; expanded?: boolean; onToggle?(): void; navigation?: FileNavigation }) {
  const t = useText()
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
  const path = navigation ? toolFilePath(name, args, navigation.workspacePath) : undefined
  const input = useMemo(() => {
    if (!expanded || args === undefined) return undefined
    if (typeof args === "string") return args
    try { return JSON.stringify(args, null, 2) } catch { return String(args) }
  }, [expanded, args])
  const text = useMemo(() => {
    if (!expanded || output === undefined) return undefined
    if (typeof output === "string") return output
    try { return JSON.stringify(output, null, 2) } catch { return String(output) }
  }, [expanded, output])
  return <div className="tool-activity">
    <div className="tool-activity-heading"><ToolSummaryRow name={name} status={t(output === undefined ? "尚未回報結果" : "已收到結果")}
      label={`${t("工具詳情")} ${name}`} expanded={expanded} onToggle={onToggle ?? (() => setExpanded((value) => !value))} />
      {path && navigation ? <button type="button" className="tool-file-link link-button" title={path} aria-label={t("在成果面板開啟 {path}", { path })} onClick={() => navigation.onOpenFile(path)}>{path}</button> : null}</div>
    {expanded ? <div className="tool-expanded-content">{input !== undefined ? <><div className="tool-detail-label">{t("呼叫參數")}</div><pre className="tool-output">{input}</pre></> : null}<div className="tool-detail-label">{t("執行輸出")}</div><pre className="tool-output">{text ?? t("尚未回報結果")}</pre></div> : null}
  </div>
}
