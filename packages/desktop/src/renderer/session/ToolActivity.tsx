import { useMemo, useState } from "react"
import { ChevronRight, Terminal } from "lucide-react"
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
    <button type="button" className="tool-summary" aria-label={`${t("工具詳情")} ${name}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <ChevronRight size={14} className={expanded ? "tool-chevron expanded" : "tool-chevron"} />
      <Terminal size={15} /><span className="tool-name">{name}</span>
      <span className="tool-status">{t(output === undefined ? "尚未回報結果" : "已收到結果")}</span>
    </button>
    {expanded ? <pre className="tool-output">{text ?? t("尚未回報結果")}</pre> : null}
  </div>
}
