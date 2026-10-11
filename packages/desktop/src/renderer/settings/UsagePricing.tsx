import { useEffect, useState } from "react"
import type { UsagePrice } from "@i-harness/usage-stats"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"
import type { UsageStatisticsProps } from "./UsageStatistics.tsx"
import type { UsageText } from "./usage-statistics-helpers.ts"

export function UsagePricing({ active, request, prices, providers, models, t, onClose, onSaved }: UsageStatisticsProps & { prices: UsagePrice[]; providers: string[]; models: string[]; t: UsageText; onClose(): void; onSaved(): void }) {
  const [provider, setProvider] = useState(providers[0] ?? "")
  const [model, setModel] = useState(models[0] ?? "")
  const [input, setInput] = useState("")
  const [output, setOutput] = useState("")
  const [cacheRead, setCacheRead] = useState("")
  const [cacheWrite, setCacheWrite] = useState("")
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const existing = prices.find(price => price.providerId === provider && price.modelId === model)
  useEffect(() => {
    setInput(existing ? String(existing.inputPerMillion) : "")
    setOutput(existing ? String(existing.outputPerMillion) : "")
    setCacheRead(existing?.cacheReadPerMillion === undefined ? "" : String(existing.cacheReadPerMillion))
    setCacheWrite(existing?.cacheCreationPerMillion === undefined ? "" : String(existing.cacheCreationPerMillion))
    setSource(existing?.source ?? "")
  }, [existing, provider, model])
  const validNumber = (value: string) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0
  const valid = !!provider.trim() && !!model.trim() && !!source.trim() && validNumber(input) && validNumber(output) && (cacheRead === "" || validNumber(cacheRead)) && (cacheWrite === "" || validNumber(cacheWrite))
  async function save() {
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await request({ kind: "desktop/usage/pricing", price: { providerId: provider.trim(), modelId: model.trim(), inputPerMillion: Number(input), outputPerMillion: Number(output), ...(cacheRead === "" ? {} : { cacheReadPerMillion: Number(cacheRead) }), ...(cacheWrite === "" ? {} : { cacheCreationPerMillion: Number(cacheWrite) }), source: source.trim(), updatedAt: Date.now() } })
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <SettingsDialog title={t("API 定價", "API pricing")} closeLabel={t("關閉", "Close")} active={active} busy={busy} initialFocusSelector="input" onClose={onClose}>
    <p className="usage-footnote">{t("單位為每百萬 Token 的美元價格。只估算 API 請求，訂閱請求不計費。留空的快取價格維持未知；0 表示明確免費。目前設定的單價適用於所有查詢歷史，並非歷史帳單。", "Prices are USD per million tokens. Only API requests are estimated; subscriptions are excluded. Blank cache prices remain unknown; 0 explicitly means free. Current configured rates apply to all queried history; these are not historical bills.")}</p>
    <form className="usage-pricing-form" onSubmit={event => { event.preventDefault(); void save() }}><div className="usage-price-grid"><label>{t("提供商 ID", "Provider ID")}<input list="usage-price-providers" value={provider} disabled={busy} required onChange={event => setProvider(event.target.value)} /></label><datalist id="usage-price-providers">{providers.map(value => <option key={value} value={value} />)}</datalist><label>{t("模型 ID", "Model ID")}<input list="usage-price-models" value={model} disabled={busy} required onChange={event => setModel(event.target.value)} /></label><datalist id="usage-price-models">{models.map(value => <option key={value} value={value} />)}</datalist>
    {[{ label: t("輸入 / 百萬", "Input / million"), value: input, set: setInput, required: true }, { label: t("輸出 / 百萬", "Output / million"), value: output, set: setOutput, required: true }, { label: t("快取讀取 / 百萬", "Cache read / million"), value: cacheRead, set: setCacheRead }, { label: t("快取寫入 / 百萬", "Cache write / million"), value: cacheWrite, set: setCacheWrite }].map(field => <label key={field.label}>{field.label}<input type="number" min="0" step="any" disabled={busy} required={field.required} placeholder={field.required ? "USD" : t("未知", "Unknown")} value={field.value} onChange={event => field.set(event.target.value)} /></label>)}</div><label>{t("價格來源", "Price source")}<input required disabled={busy} value={source} placeholder={t("來源網址或說明", "Source URL or description")} onChange={event => setSource(event.target.value)} /></label>
    {existing && <p className="usage-footnote">{t("上次更新：", "Last updated: ")}{new Date(existing.updatedAt).toLocaleString()}</p>}{error && <p role="alert">{error}</p>}<div className="usage-price-actions"><Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit" disabled={!valid || busy}>{busy ? t("儲存中…", "Saving…") : t("儲存定價", "Save pricing")}</Button></div></form>
  </SettingsDialog>
}
