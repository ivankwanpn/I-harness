import { useState } from "react"
import { useText } from "../design/i18n.ts"
export function McpSecrets({ keys, patch, onChange }: { keys: string[]; patch: Record<string, string | null>; onChange(patch: Record<string, string | null>): void }) {
  const t = useText()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  return <div className="mcp-secrets">
    <p className="muted">{t("已保存的值不會回傳；留空保持不變，移除會在儲存後生效。")}</p>
    {[...new Set([...keys, ...Object.keys(patch)])].map((key) => <div className="mcp-secret-row" key={key}>
      <span>{key}</span><input type="password" autoComplete="new-password" aria-label={key} placeholder={t(patch[key] === null ? "待移除" : "已保存的值保持不變")} disabled={patch[key] === null} value={patch[key] ?? ""} onChange={(event) => { const next = { ...patch }; if (event.target.value) next[key] = event.target.value; else delete next[key]; onChange(next) }} />
      <button type="button" onClick={() => { const next = { ...patch }; if (patch[key] === null) delete next[key]; else next[key] = null; onChange(next) }}>{t(patch[key] === null ? "取消" : "移除")}</button>
    </div>)}
    <div className="mcp-secret-row"><input aria-label={t("私密欄位名稱")} value={name} placeholder={t("私密欄位名稱")} onChange={(event) => setName(event.target.value)} /><input type="password" autoComplete="new-password" aria-label={t("私密欄位值")} value={value} placeholder={t("私密欄位值")} onChange={(event) => setValue(event.target.value)} /><button type="button" disabled={!name.trim() || !value} onClick={() => { onChange({ ...patch, [name.trim()]: value }); setName(""); setValue("") }}>{t("加入")}</button></div>
  </div>
}
