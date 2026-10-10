import { useText } from "../design/i18n.ts"
import { useSettingsDraft } from "./settings-drafts.tsx"
export interface McpSecretInput { name: string; value: string }
export function McpSecrets({ keys, patch, onChange, draftIdentity = ["mcp-secrets"], input, onInputChange }: { keys: string[]; patch: Record<string, string | null>; onChange(patch: Record<string, string | null>): void; draftIdentity?: readonly string[]; input?: McpSecretInput; onInputChange?(input: McpSecretInput): void }) {
  const t = useText()
  const [localName, setLocalName] = useSettingsDraft([...draftIdentity, "name"], "")
  const [localValue, setLocalValue] = useSettingsDraft([...draftIdentity, "value"], "")
  const name = input?.name ?? localName, value = input?.value ?? localValue
  const setName = (name: string) => onInputChange ? onInputChange({ name, value }) : setLocalName(name)
  const setValue = (value: string) => onInputChange ? onInputChange({ name, value }) : setLocalValue(value)
  return <div className="mcp-secrets">
    <p className="muted">{t("已保存的值不會回傳；留空保持不變，移除會在儲存後生效。")}</p>
    {[...new Set([...keys, ...Object.keys(patch)])].map((key) => <div className="mcp-secret-row" key={key}>
      <span>{key}</span><input type="password" autoComplete="new-password" aria-label={key} placeholder={t(patch[key] === null ? "待移除" : "已保存的值保持不變")} disabled={patch[key] === null} value={patch[key] ?? ""} onChange={(event) => { const next = { ...patch }; if (event.target.value) next[key] = event.target.value; else delete next[key]; onChange(next) }} />
      <button type="button" onClick={() => { const next = { ...patch }; if (patch[key] === null) delete next[key]; else next[key] = null; onChange(next) }}>{t(patch[key] === null ? "取消" : "移除")}</button>
    </div>)}
    <div className="mcp-secret-row"><input aria-label={t("私密欄位名稱")} value={name} placeholder={t("私密欄位名稱")} onChange={(event) => setName(event.target.value)} /><input type="password" autoComplete="new-password" aria-label={t("私密欄位值")} value={value} placeholder={t("私密欄位值")} onChange={(event) => setValue(event.target.value)} /><button type="button" disabled={!name.trim() || !value} onClick={() => { onChange({ ...patch, [name.trim()]: value }); if (onInputChange) onInputChange({ name: "", value: "" }); else { setLocalName(""); setLocalValue("") } }}>{t("加入")}</button></div>
  </div>
}
