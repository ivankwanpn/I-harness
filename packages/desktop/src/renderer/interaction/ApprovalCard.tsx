import { useState } from "react"
import { PermissionCard } from "../vendor/zcode/PermissionCard.tsx"
import { useText } from "../design/i18n.ts"

export function ApprovalCard({ requestId, description, busy, onConfirm }: {
  requestId: string; description: string; busy: boolean; onConfirm(approved: boolean): void
}) {
  const t = useText()
  const [approved, setApproved] = useState(true)
  return <PermissionCard requestId={requestId} title={t("需要你的確認")}
    preview={<p className="approval-description">{description}</p>}
    options={[
      { id: "allow", label: t("批准"), description: t("僅允許這一次") },
      { id: "deny", label: t("拒絕"), description: t("不執行此操作") },
    ]}
    selectedId={approved ? "allow" : "deny"} responding={busy} onSelect={(id) => setApproved(id === "allow")}
    hint={t("選擇後按確認送出")} confirmLabel={t(busy ? "正在送出…" : "確認")}
    onConfirm={() => onConfirm(approved)} />
}
