import { useState } from "react"
import { ShieldAlert } from "lucide-react"
import { useText } from "../design/i18n.ts"
import type { ApprovalRememberView } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import type { RememberApprovalOptions } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { useToolText } from "../session/tool-text.ts"
import "./question-card.css"

function approvalCommand(details: string | undefined): string | undefined {
  if (!details) return undefined
  try {
    const value = JSON.parse(details) as { command?: unknown } | null
    return typeof value?.command === "string" && value.command.trim() ? value.command : undefined
  } catch { return undefined }
}

export function ApprovalCard({ requestId, description, details, busy, interrupted, remember, onConfirm }: {
  requestId: string; description: string; details?: string; busy: boolean; interrupted?: boolean; remember?: ApprovalRememberView; onConfirm(approved: boolean, remember?: RememberApprovalOptions): void
}) {
  const t = useText()
  const tt = useToolText()
  const [rememberChecked, setRememberChecked] = useState(false)
  const [scope, setScope] = useState<RememberApprovalOptions["scope"]>("session")
  const [duration, setDuration] = useState(3600000)
  const title = t(interrupted ? "等待期間已中斷" : "需要你的確認")
  const allow = t(interrupted ? "儲存重新評估請求" : "批准")
  const deny = t(interrupted ? "捨棄請求" : "拒絕")
  const command = approvalCommand(details)
  const tool = command ? /^([\w-]+)\s*[:：]\s*dangerous command requires approval[:：]/i.exec(description)?.[1] : undefined
  const expandedAccess = /^([\w-]+)\s*[:：]\s*escalate sandbox to danger-full-access\b/i.exec(description)?.[1]
  const preview = command ?? (expandedAccess ? description : undefined)
  const rememberable = !interrupted && remember?.available && !!remember.arguments
  const saveRule = rememberable && rememberChecked
  return <section className="ih-interaction-card ih-approval-card ih-control-scope" aria-label={title} aria-busy={busy} data-request-id={requestId} data-expanded-access={expandedAccess ? "" : undefined}>
      <header className="ih-interaction-head">
        <span className="ih-interaction-icon" aria-hidden="true"><ShieldAlert size={18} /></span>
        <div className="ih-interaction-heading">
          <h2 className="ih-interaction-title">{title}</h2>
          <p className="ih-interaction-context">{expandedAccess ? tt(`${expandedAccess} 申請以完整存取權執行`, `${expandedAccess} requests full access for this command`)
            : tool ? tt(`代理申請執行 ${tool} 指令`, `The agent requests permission to run ${tool}`) : description}</p>
        </div>
      </header>
      {interrupted ? <p className="ih-interaction-banner">{t("此操作尚未獲得核准。繼續會話後，代理會重新評估並依目前設定要求核准。")}</p> : null}
      {preview ? <pre className="ih-approval-command" tabIndex={0} aria-label={tt("待核准的指令", "Command awaiting approval")}>{preview}</pre> : null}
      {details || remember?.reason ? <details className="ih-interaction-details"><summary>{t("詳細資料")}</summary>
        {details ? <pre className="approval-details">{details}</pre> : null}
        {!interrupted && remember?.reason ? <p>{remember.reason}</p> : null}
      </details> : null}
      {rememberable ? <fieldset disabled={busy} className="ih-approval-remember">
        <label><input type="checkbox" aria-label={t("記住此操作的完整參數")} checked={rememberChecked} onChange={(event) => setRememberChecked(event.target.checked)} />{t("記住此操作的完整參數")}</label>
        {rememberChecked ? <>
          <pre className="approval-details">{remember.arguments}</pre>
          <label>{t("規則作用範圍")}<select aria-label={t("規則作用範圍")} value={scope} onChange={(event) => setScope(event.target.value as RememberApprovalOptions["scope"])}><option value="session">{t("此會話")}</option><option value="workspace">{t("此專案")}</option></select></label>
          <label>{t("有效期限")}<select aria-label={t("有效期限")} value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={3600000}>{t("1 小時")}</option><option value={86400000}>{t("1 天")}</option><option value={604800000}>{t("7 天")}</option></select></label>
          <p className="notice">{t("只重用相同工具身分與完整參數。沙箱、Plan Mode、角色及 Hooks 仍會檢查；工具或設定改變後會重新詢問。")}</p>
        </> : null}
      </fieldset> : null}
      <footer className="ih-interaction-footer" role="group" aria-label={title}>
        {!interrupted ? <span className="ih-interaction-hint">{t(saveRule ? "批准並保存規則" : "僅允許這一次")}</span> : null}
        <div className="ih-interaction-actions">
          <Button disabled={busy} onClick={() => onConfirm(false)}>{deny}</Button>
          <Button variant={expandedAccess && !interrupted ? "danger" : "primary"} loading={busy} aria-label={allow} onClick={() => onConfirm(true, saveRule ? { scope, expiresAt: Date.now() + duration } : undefined)}>
            {interrupted || saveRule ? allow : tt("批准本次", "Approve once")}
          </Button>
        </div>
      </footer>
  </section>
}
