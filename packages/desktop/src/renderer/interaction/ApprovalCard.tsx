import { useState } from "react"
import { ShieldCheck } from "lucide-react"
import { useText } from "../design/i18n.ts"

export function ApprovalCard({ requestId, description, busy, onConfirm }: {
  requestId: string; description: string; busy: boolean; onConfirm(approved: boolean): void
}) {
  const t = useText()
  const [approved, setApproved] = useState(true)
  return <form className="approval-card" onSubmit={(event) => { event.preventDefault(); if (!busy) onConfirm(approved) }}>
    <h3 className="approval-heading"><ShieldCheck size={16} />{t("需要你的確認")}</h3>
    <p className="approval-description">{description}</p>
    <fieldset disabled={busy} className="approval-options">
      <legend className="visually-hidden">{t("選擇回覆")}</legend>
      {[true, false].map((allow, index) => <label key={String(allow)} className={approved === allow ? "approval-option selected" : "approval-option"}>
        <input type="radio" name={`approval-${requestId}`} checked={approved === allow} onChange={() => setApproved(allow)} />
        <span className="muted" aria-hidden="true">{index + 1}.</span>
        <span>{t(allow ? "批准" : "拒絕")}</span>
        <span className="muted">{t(allow ? "僅允許這一次" : "不執行此操作")}</span>
      </label>)}
    </fieldset>
    <footer className="approval-footer"><span className="muted">{t("選擇後按確認送出")}</span><button type="submit" className="approval-confirm" disabled={busy}>{t(busy ? "正在送出…" : "確認")}</button></footer>
  </form>
}
