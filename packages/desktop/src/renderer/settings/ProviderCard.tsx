import { useRef, useState } from "react"
import { Pencil, Plus, Trash2, Star } from "lucide-react"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import { ProviderEditor, type EditableProvider, type EditableModel } from "./ProviderEditor.tsx"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { ProviderDiscovery } from "./ProviderDiscovery.tsx"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SettingsDialog } from "./SettingsDialog.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDraftScope, useSettingsDraft } from "./settings-drafts.tsx"

export interface DirectoryRow extends EditableProvider {
  auth: { configured: boolean; writable?: boolean; source?: string }
  models: EditableModel[]
  defaultModel?: string
  selectedDefaultModel?: string
}
interface ProviderCardProps { row: DirectoryRow; onSave(command: ProviderCommand): Promise<void>; bridge?: DesktopBridge; workspaceId?: string; active?: boolean }
export function ProviderCard(props: ProviderCardProps) {
  return <SettingsDraftScope owner={props.bridge ?? props.onSave}><ProviderCardContent key={JSON.stringify([props.workspaceId, props.row.id])} {...props} /></SettingsDraftScope>
}
function ProviderCardContent({ row, onSave, bridge, workspaceId, active = true }: ProviderCardProps) {
  const t = useText()
  const [editor, setEditor] = useState<"provider" | "new-model" | EditableModel>()
  const [editorBusy, setEditorBusy] = useState(false)
  const editorTrigger = useRef<HTMLButtonElement>(null)
  const [key, setKey] = useSettingsDraft(["providers", workspaceId ?? "direct", row.id, "key"], "")
  const [keyOpen, setKeyOpen] = useSettingsDraft(["providers", workspaceId ?? "direct", row.id, "key-open"], false)
  const [confirm, setConfirm] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const openEditor = (next: "provider" | "new-model" | EditableModel, trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger
    setEditorBusy(false)
    setError(undefined)
    setEditor(next)
  }
  const closeEditor = () => {
    setEditor(undefined)
    setTimeout(() => editorTrigger.current?.focus(), 0)
  }
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
  return <div hidden={!active} className="provider-card"><SettingsGroup>
    <header className="provider-card-heading"><div><h3>{row.displayName}</h3><p className="muted">{row.id}</p></div><span className="provider-auth-badge" data-configured={row.auth.configured}>{t(row.auth.configured ? "憑證已設定" : "憑證未設定")}</span></header>
    <div className="provider-actions">
      <button disabled={busy} onClick={(event) => openEditor("provider", event.currentTarget)}>{t("編輯提供商")}</button>
      <button disabled={busy || row.auth.writable === false} onClick={() => setKeyOpen(!keyOpen)}>{t("設定 API key")}</button>
      {row.configured ? <button disabled={busy} onClick={() => remove("provider", { action: "provider/remove", id: row.id })}>{t(confirm === "provider" ? "確認移除提供商" : "移除提供商")}</button> : null}
    </div>
    <div className="provider-connection-summary">
      <SettingsRow label={t("API 網址")} control={<code>{row.baseURL || t("未指定")}</code>} />
    </div>
    {keyOpen ? <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); run({ action: "key/set", id: row.id, value: key }, () => { setKey(""); setKeyOpen(false) }) }}>
      <label>API key<input type="password" autoComplete="off" required maxLength={16384} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} /></label>
      <div className="provider-actions"><button disabled={busy} type="submit">{t("儲存")}</button><button type="button" disabled={busy || !row.auth.configured} onClick={() => remove("key", { action: "key/clear", id: row.id })}>{t(confirm === "key" ? "確認清除 API key" : "清除 API key")}</button></div>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    {confirm ? <button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
    {editor !== undefined ? <SettingsDialog active={active} title={t(editor === "provider" ? "編輯提供商" : editor === "new-model" ? "新增模型" : "編輯模型")} closeLabel={t("關閉對話框")} busy={editorBusy} onClose={closeEditor} initialFocusSelector={typeof editor === "object" ? ".provider-editor input[type='number']:not(:disabled)" : ".provider-editor input:not(:disabled)"}>
      <ProviderEditor key={JSON.stringify(typeof editor === "string" ? [editor] : ["model", editor.id])} draftIdentity={["providers", workspaceId ?? "direct", row.id, ...(typeof editor === "string" ? [editor] : ["model", editor.id])]} id={row.id} provider={editor === "provider" ? row : undefined} model={typeof editor === "object" ? editor : undefined} newModel={editor === "new-model"} onSave={save} onClose={closeEditor} onBusyChange={setEditorBusy} />
    </SettingsDialog> : null}
    <section className="provider-models"><header><h3>{t("模型數量：{count}", { count: row.models.length })}</h3>
      <Button variant="secondary" size="small" icon={<Plus size={15} />} disabled={busy} onClick={(event) => openEditor("new-model", event.currentTarget)}>{t("新增模型")}</Button></header>
      {row.models.map((model) => <div className="provider-model-row" key={model.id}>
        <div className="provider-model-name"><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id ? <small>{model.id}</small> : null}</div>
        {model.protocol || row.protocol ? <span className="provider-model-protocol" title={t("通訊協定")}>{model.protocol || row.protocol}</span> : null}
        {model.inputModalities?.includes("image") ? <span className="provider-model-vision" title={t("輸入類型")}>{t("圖片")}</span> : null}
        <span className="provider-model-context" title={`${t("上下文大小")}：${model.contextWindow === undefined ? t("未指定") : new Intl.NumberFormat("en-US").format(model.contextWindow)}`}>{model.contextWindow === undefined ? t("未指定") : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(model.contextWindow)}</span>
        <div className="provider-model-actions"><button title={t("編輯模型")} aria-label={t("編輯模型")} disabled={busy} onClick={(event) => openEditor(model, event.currentTarget)}><Pencil size={15} /></button><button title={t("設為預設模型")} aria-label={t("設為預設模型")} aria-pressed={row.selectedDefaultModel === model.id} disabled={busy} onClick={() => run({ action: "default/set", id: row.id, model: model.id })}><Star size={15} /></button><button title={t(confirm === `model:${model.id}` ? "確認移除模型" : "移除模型")} aria-label={t(confirm === `model:${model.id}` ? "確認移除模型" : "移除模型")} disabled={busy} onClick={() => remove(`model:${model.id}`, { action: "model/remove", id: row.id, model: model.id })}>{confirm === `model:${model.id}` ? t("確認移除模型") : <Trash2 size={15} />}</button></div>
      </div>)}
      {bridge && workspaceId ? <ProviderDiscovery active={active} bridge={bridge} workspaceId={workspaceId} id={row.id} onSave={save} /> : null}
    </section>
  </SettingsGroup></div>
}
