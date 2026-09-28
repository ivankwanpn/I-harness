import { useText } from "../design/i18n.ts"

export function ApprovalCard({ requestId, description, details, busy, onConfirm }: {
  requestId: string; description: string; details?: string; busy: boolean; onConfirm(approved: boolean): void
}) {
  const t = useText()
  return <div className="zc-permission w-full shrink-0 relative z-1" aria-busy={busy} data-request-id={requestId}>
    <div className="w-full overflow-hidden rounded-2xl border border-border bg-popover p-3 shadow-xs">
      <p className="text-ui-base font-medium leading-tight text-foreground-subtle">{t("需要你的確認")}</p>
      <p className="approval-description mt-3">{description}</p>
      {details ? <pre className="approval-details">{details}</pre> : null}
      <div className="mt-3 space-y-1" role="group" aria-label={t("需要你的確認")}>
        <button type="button" aria-label={t("批准")} disabled={busy} onClick={() => onConfirm(true)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{t("批准")}</span><span className="text-ui-base text-foreground-subtle">{t("僅允許這一次")}</span></span>
        </button>
        <button type="button" aria-label={t("拒絕")} disabled={busy} onClick={() => onConfirm(false)} className="zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60">
          <span className="min-w-0 flex flex-1 flex-col"><span className="text-ui-base font-medium text-foreground">{t("拒絕")}</span><span className="text-ui-base text-foreground-subtle">{t("不執行此操作")}</span></span>
        </button>
      </div>
    </div>
  </div>
}
