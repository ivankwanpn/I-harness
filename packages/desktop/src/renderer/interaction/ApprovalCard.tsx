import { useState } from "react"
import { useText } from "../design/i18n.ts"
import type { ApprovalRememberView } from "@i-harness/desktop-gateway/src/approval-rules.ts"
import type { RememberApprovalOptions } from "@i-harness/desktop-gateway/src/approval-rules.ts"

export function ApprovalCard({ requestId, description, details, busy, interrupted, remember, onConfirm }: {
  requestId: string; description: string; details?: string; busy: boolean; interrupted?: boolean; remember?: ApprovalRememberView; onConfirm(approved: boolean, remember?: RememberApprovalOptions): void
}) {
  const t = useText()
  const [rememberChecked, setRememberChecked] = useState(false)
  const [scope, setScope] = useState<RememberApprovalOptions["scope"]>("session")
  const [duration, setDuration] = useState(3600000)
  const title = t(interrupted ? "等待期間已中斷" : "需要你的確認")
  const allow = t(interrupted ? "儲存重新評估請求" : "批准")
  const deny = t(interrupted ? "捨棄請求" : "拒絕")
  return <div className="zc-permission w-full shrink-0 relative z-1" aria-busy={busy} data-request-id={requestId}>
    <div className="w-full overflow-hidden rounded-2xl border border-border bg-popover p-3 shadow-xs">
      <p className="text-ui-base font-medium leading-tight text-foreground-subtle">{title}</p>
      {interrupted ? <p className="notice">{t("此操作尚未獲得核准。繼續會話後，代理會重新評估並依目前設定要求核准。")}</p> : null}
      <p className="approval-description mt-3">{description}</p>
      {details ? <pre className="approval-details">{details}</pre> : null}
      {!interrupted && remember ? remember.available && remember.arguments ? <fieldset disabled={busy} className="settings-group">
        <label><input type="checkbox" aria-label={t("記住此操作的完整參數")} checked={rememberChecked} onChange={(event) => setRememberChecked(event.target.checked)} />{t("記住此操作的完整參數")}</label>
        {rememberChecked ? <>
          <pre className="approval-details">{remember.arguments}</pre>
          <label>{t("規則作用範圍")}<select aria-label={t("規則作用範圍")} value={scope} onChange={(event) => setScope(event.target.value as RememberApprovalOptions["scope"])}><option value="session">{t("此會話")}</option><option value="workspace">{t("此專案")}</option></select></label>
          <label>{t("有效期限")}<select aria-label={t("有效期限")} value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={3600000}>{t("1 小時")}</option><option value={86400000}>{t("1 天")}</option><option value={604800000}>{t("7 天")}</option></select></label>
          <p className="notice">{t("只重用相同工具身分與完整參數。沙箱、Plan Mode、角色及 Hooks 仍會檢查；工具或設定改變後會重新詢問。")}</p>
        </> : null}
      </fieldset> : <p className="notice">{t("此操作只支援單次核准")}{remember.reason ? `：${remember.reason}` : ""}</p> : null}
      <div className="mt-3 space-y-1" role="group" aria-label={title}>
        <button type="button" aria-label={allow} disabled={busy} onClick={() => onConfirm(true, !interrupted && remember?.available && rememberChecked ? { scope, expiresAt: Date.now() + duration } : undefined)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{allow}</span>{interrupted ? null : <span className="text-ui-base text-foreground-subtle">{t(rememberChecked ? "批准並保存規則" : "僅允許這一次")}</span>}</span>
        </button>
        <button type="button" aria-label={deny} disabled={busy} onClick={() => onConfirm(false)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{deny}</span>{interrupted ? null : <span className="text-ui-base text-foreground-subtle">{t("不執行此操作")}</span>}</span>
        </button>
      </div>
    </div>
  </div>
}
