import { useMemo, useState } from "react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { useText } from "../design/i18n.ts"

export function ToolActivity({ name, args, output, expanded: controlled, onToggle }: { name: string; args?: unknown; output?: unknown; expanded?: boolean; onToggle?(): void }) {
  const t = useText()
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
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
    <ToolSummaryRow name={name} status={t(output === undefined ? "尚未回報結果" : "已收到結果")}
      label={`${t("工具詳情")} ${name}`} expanded={expanded} onToggle={onToggle ?? (() => setExpanded((value) => !value))} />
    {expanded ? <div className="tool-expanded-content">{input !== undefined ? <><div className="tool-detail-label">{t("呼叫參數")}</div><pre className="tool-output">{input}</pre></> : null}<div className="tool-detail-label">{t("執行輸出")}</div><pre className="tool-output">{text ?? t("尚未回報結果")}</pre></div> : null}
  </div>
}
