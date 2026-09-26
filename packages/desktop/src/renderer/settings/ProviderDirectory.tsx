import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

interface DirectoryRow {
  id: string
  displayName: string
  protocol?: string
  auth: { configured: boolean }
  models: { id: string; contextWindow?: number }[]
}

/** Displays the backend directory; loading never probes a provider endpoint. */
export function ProviderDirectory({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [rows, setRows] = useState<DirectoryRow[]>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setRows(undefined)
    setError(undefined)
    void bridge.request({ kind: "desktop/provider/directory", workspaceId }).then((result) => {
      if (active) setRows(result as DirectoryRow[])
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  return <section aria-label={t("模型與提供商")}>
    <h2>{t("模型與提供商")}</h2>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></div>
      : rows === undefined ? <p role="status">{t("讀取提供商目錄中…")}</p>
      : rows.length === 0 ? <p>{t("沒有可用的提供商")}</p>
      : rows.map((row) => <SettingsGroup key={row.id}>
        <SettingsRow label={row.displayName} description={[row.id, row.protocol].filter(Boolean).join(" · ")} control={<span>{t(row.auth.configured ? "憑證已設定" : "憑證未設定")}</span>} />
        <details><summary>{t("模型數量：{count}", { count: row.models.length })}</summary>
          {row.models.map((model) => <SettingsRow key={model.id} label={model.id} description={t("上下文大小")} control={<span>{model.contextWindow ?? t("未指定")}</span>} />)}
        </details>
      </SettingsGroup>)}
  </section>
}
