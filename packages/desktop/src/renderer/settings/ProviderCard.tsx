import { useRef, useState } from "react"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import { ProviderEditor, type EditableProvider, type EditableModel } from "./ProviderEditor.tsx"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export interface DirectoryRow extends EditableProvider {
  auth: { configured: boolean; writable?: boolean; source?: string }
  models: EditableModel[]
  defaultModel?: string
}
export function ProviderCard({ row, onSave }: { row: DirectoryRow; onSave(command: ProviderCommand): Promise<void> }) {
  const t = useText()
  const [editor, setEditor] = useState<"provider" | "new-model" | EditableModel>()
  const [key, setKey] = useState("")
  const [keyOpen, setKeyOpen] = useState(false)
  const [confirm, setConfirm] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const save = async (command: ProviderCommand) => {
    if (locked.current) throw new Error(t("操作進行中"))
    locked.current = true; setBusy(true); setError(undefined)
    try { await onSave(command); setConfirm(undefined) }
    finally { locked.current = false; setBusy(false) }
  }
  const run = (command: ProviderCommand, done?: () => void) => { void save(command).then(done).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))) }
  const remove = (target: string, command: ProviderCommand) => {
    if (confirm === target) run(command)
    else setConfirm(target)
  }
  return <SettingsGroup>
    <SettingsRow label={row.displayName} description={[row.id, row.protocol].filter(Boolean).join(" · ")} control={<span>{t(row.auth.configured ? "憑證已設定" : "憑證未設定")}</span>} />
    <div className="provider-actions">
      <button disabled={busy} onClick={() => setEditor("provider")}>{t("編輯提供商")}</button>
      <button disabled={busy || row.auth.writable === false} onClick={() => { setKeyOpen(!keyOpen); setKey("") }}>{t("設定 API key")}</button>
      {row.configured ? <button disabled={busy} onClick={() => remove("provider", { action: "provider/remove", id: row.id })}>{t(confirm === "provider" ? "確認移除提供商" : "移除提供商")}</button> : null}
    </div>
    {keyOpen ? <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); run({ action: "key/set", id: row.id, value: key }, () => { setKey(""); setKeyOpen(false) }) }}>
      <label>API key<input type="password" autoComplete="off" required maxLength={16384} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} /></label>
      <div className="provider-actions"><button disabled={busy} type="submit">{t("儲存")}</button><button type="button" disabled={busy || !row.auth.configured} onClick={() => remove("key", { action: "key/clear", id: row.id })}>{t(confirm === "key" ? "確認清除 API key" : "清除 API key")}</button></div>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    {confirm ? <button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
    <details><summary>{t("模型數量：{count}", { count: row.models.length })}</summary>
      {row.models.map((model) => <div key={model.id}>
        <SettingsRow label={model.id} description={t("上下文大小")} control={<span>{model.contextWindow ?? t("未指定")}</span>} />
        <div className="provider-actions"><button disabled={busy} onClick={() => setEditor(model)}>{t("編輯模型")}</button><button disabled={busy} onClick={() => run({ action: "default/set", id: row.id, model: model.id })}>{t("設為預設模型")}</button><button disabled={busy} onClick={() => remove(`model:${model.id}`, { action: "model/remove", id: row.id, model: model.id })}>{t(confirm === `model:${model.id}` ? "確認移除模型" : "移除模型")}</button></div>
      </div>)}
      <button disabled={busy} onClick={() => setEditor("new-model")}>{t("新增模型")}</button>
    </details>
    {editor !== undefined ? <ProviderEditor key={typeof editor === "string" ? editor : editor.id} id={row.id} provider={editor === "provider" ? row : undefined} model={typeof editor === "object" ? editor : undefined} newModel={editor === "new-model"} onSave={save} onClose={() => setEditor(undefined)} /> : null}
  </SettingsGroup>
}
