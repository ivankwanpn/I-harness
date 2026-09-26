import { useState } from "react"
import type { SessionOperation } from "./use-session-operation.ts"
import { useText } from "../design/i18n.ts"

export function CompactionPanel({ operation, disabled, onCompact, onCancel }: {
  operation?: SessionOperation; disabled: boolean; onCompact(instructions?: string): Promise<void>; onCancel(): void
}) {
  const t = useText()
  const [instructions, setInstructions] = useState("")
  const compact = operation?.kind === "compact" ? operation : undefined
  const busy = compact?.busy === true
  const result = compact?.result
  const tooLong = new TextEncoder().encode(instructions).length > 4096
  return <section className="compaction-panel" aria-label={t("壓縮上下文")}>
    <h2>{t("壓縮上下文")}</h2>
    <p className="muted">{t("整理目前會話的上下文；可能呼叫模型。保留重點可留空。")}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !disabled && !tooLong) void onCompact(instructions).catch(() => undefined) }}>
      <label>{t("希望保留的重點")}<textarea rows={3} value={instructions} disabled={busy} onChange={(event) => setInstructions(event.target.value)} /></label>
      {tooLong ? <p role="alert" className="error-text">{t("內容超過 4096 bytes，請縮短。")}</p> : null}
      <div className="compaction-actions"><button className="primary-button" disabled={disabled || busy || tooLong}>{t(busy ? "正在壓縮…" : "開始壓縮")}</button>
        {busy ? <button type="button" className="primary-button" onClick={onCancel}>{t("停止")}</button> : null}</div>
    </form>
    {compact?.error ? <p role="alert" className="error-text">{compact.error}</p> : null}
    {result ? <p role="status">{t(result.reason === "summarizer-failed" ? "摘要產生失敗，未完成壓縮。" : result.compacted ? "上下文已整理完成。" : "目前沒有需要壓縮的內容。")}</p> : null}
    {result?.summary ? <details><summary>{t("查看摘要")}</summary><pre className="tool-output">{result.summary}</pre></details> : null}
  </section>
}
