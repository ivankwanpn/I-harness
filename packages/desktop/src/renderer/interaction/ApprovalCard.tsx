import { useText } from "../design/i18n.ts"

export function ApprovalCard({ requestId, description, details, busy, interrupted, onConfirm }: {
  requestId: string; description: string; details?: string; busy: boolean; interrupted?: boolean; onConfirm(approved: boolean): void
}) {
  const t = useText()
  const title = t(interrupted ? "等待期間已中斷" : "需要你的確認")
  const allow = t(interrupted ? "儲存重新評估請求" : "批准")
  const deny = t(interrupted ? "捨棄請求" : "拒絕")
  return <div className="zc-permission w-full shrink-0 relative z-1" aria-busy={busy} data-request-id={requestId}>
    <div className="w-full overflow-hidden rounded-2xl border border-border bg-popover p-3 shadow-xs">
      <p className="text-ui-base font-medium leading-tight text-foreground-subtle">{title}</p>
      {interrupted ? <p className="notice">{t("此操作尚未獲得核准。繼續會話後，代理會重新評估並依目前設定要求核准。")}</p> : null}
      <p className="approval-description mt-3">{description}</p>
      {details ? <pre className="approval-details">{details}</pre> : null}
      <div className="mt-3 space-y-1" role="group" aria-label={title}>
        <button type="button" aria-label={allow} disabled={busy} onClick={() => onConfirm(true)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{allow}</span>{interrupted ? null : <span className="text-ui-base text-foreground-subtle">{t("僅允許這一次")}</span>}</span>
        </button>
        <button type="button" aria-label={deny} disabled={busy} onClick={() => onConfirm(false)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{deny}</span>{interrupted ? null : <span className="text-ui-base text-foreground-subtle">{t("不執行此操作")}</span>}</span>
        </button>
      </div>
    </div>
  </div>
}
