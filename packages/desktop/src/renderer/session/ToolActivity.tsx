import { useMemo, useState } from "react"
import { ToolSummaryRow } from "../vendor/zcode/ToolSummaryRow.tsx"
import { useText } from "../design/i18n.ts"

export function ToolActivity({ name, output }: { name: string; output?: unknown }) {
  const t = useText()
  const [expanded, setExpanded] = useState(false)
  const text = useMemo(() => {
    if (!expanded || output === undefined) return undefined
    if (typeof output === "string") return output
    try { return JSON.stringify(output, null, 2) } catch { return String(output) }
  }, [expanded, output])
  return <div className="tool-activity">
    <ToolSummaryRow name={name} status={t(output === undefined ? "尚未回報結果" : "已收到結果")}
      label={`${t("工具詳情")} ${name}`} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
    {expanded ? <pre className="tool-output">{text ?? t("尚未回報結果")}</pre> : null}
  </div>
}
