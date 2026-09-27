import { useRef, useState } from "react"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import { useText, type Message } from "../design/i18n.ts"

export interface EditableModel { id: string; name?: string; contextWindow?: number; maxTokens?: number; protocol?: string; inputModalities?: ("text" | "image")[] }
export interface EditableProvider { id: string; displayName: string; baseURL?: string; modelsURL?: string; catalog?: string; apiKeyEnv?: string; protocol?: string; configured?: boolean }
const protocols = ["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"]
const modelFields = { name: "顯示名稱", contextWindow: "上下文大小", maxTokens: "最大輸出 Token", protocol: "通訊協定", inputModalities: "輸入類型" } as const
const providerFields = { displayName: "顯示名稱", baseURL: "API 網址", modelsURL: "模型列表網址", catalog: "模型規格來源", apiKeyEnv: "API key 環境變數", protocol: "通訊協定" } as const
function fieldValue(key: string, value: unknown): string {
  if (key === "inputModalities" && Array.isArray(value)) {
    if (value.includes("text") && value.includes("image")) return "text,image"
    return value.join(",")
  }
  return String(value ?? "")
}

/** Local unsaved form state only. Blank edits clear overrides; unchanged fields
 * are omitted so independent changes to another field remain intact. */
export function ProviderEditor({ id, provider, model, newModel = false, onSave, onClose }: {
  id?: string; provider?: EditableProvider; model?: EditableModel; newModel?: boolean
  onSave(command: ProviderCommand): Promise<void>; onClose(): void
}) {
  const t = useText()
  const isModel = model !== undefined || newModel
  const initial = useRef<Record<string, unknown>>({ ...(isModel ? model : provider) })
  const labels: Record<string, Message> = isModel ? modelFields : providerFields
  const [identity, setIdentity] = useState(isModel ? model?.id ?? "" : provider?.id ?? "")
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(labels).map((key) => [key, fieldValue(key, initial.current[key])])))
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState<string>()
  const existing = isModel ? model !== undefined : provider?.configured === true
  return <form className="provider-editor" onSubmit={(event) => {
    event.preventDefault()
    if (inFlight.current) return
    const fields: Record<string, string | number | string[] | null> = {}
    for (const [key, value] of Object.entries(values)) {
      if (existing && value === fieldValue(key, initial.current[key])) continue
      if (value === "") { if (existing) fields[key] = null; continue }
      if (key === "inputModalities") { fields[key] = value.split(","); continue }
      if (key === "contextWindow" || key === "maxTokens") {
        const number = Number(value)
        if (!Number.isSafeInteger(number) || number < 1) { setError(t("請輸入正整數")); return }
        fields[key] = number
      } else fields[key] = value
    }
    const command = isModel
      ? { action: existing ? "model/edit" : "model/add", id: id!, model: identity, fields }
      : { action: existing ? "provider/edit" : "provider/create", id: provider?.id ?? identity, fields }
    inFlight.current = true; setBusy(true); setError(undefined)
    void onSave(command as ProviderCommand).then(onClose).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { inFlight.current = false; setBusy(false) })
  }}>
    <fieldset disabled={busy}>
      <legend>{t(isModel ? "編輯模型" : "編輯提供商")}</legend>
      <label>{t(isModel ? "模型 ID" : "提供商 ID")}<input required maxLength={isModel ? 256 : 128} value={identity} disabled={model !== undefined || provider !== undefined} onChange={(event) => setIdentity(event.target.value)} /></label>
      {Object.entries(labels).map(([key, label]) => <label key={key}>{t(label)}{key === "protocol"
        ? <select value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })}><option value="">{t("未指定")}</option>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</select>
        : key === "inputModalities" ? <select value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })}><option value="">{t("未指定")}</option><option value="text">{t("僅文字")}</option><option value="text,image">{t("文字與圖片")}</option>{values[key] === "image" ? <option value="image" disabled>{t("僅圖片（舊設定）")}</option> : null}</select>
        : <input type={key === "contextWindow" || key === "maxTokens" ? "number" : "text"} min={1} step={1} maxLength={2048} value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />}</label>)}
      <p className="muted">{t("留空以清除覆寫；未更改的欄位不會寫入。")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="provider-actions"><button type="submit" className="primary-button">{t(busy ? "儲存中…" : "儲存")}</button><button type="button" onClick={onClose}>{t("取消")}</button></div>
    </fieldset>
  </form>
}
