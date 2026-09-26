import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { useUiStore } from "../shell/ui-store.ts"
import { ProviderCard, type DirectoryRow } from "./ProviderCard.tsx"
import { ProviderEditor } from "./ProviderEditor.tsx"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"

/** Displays the backend directory; loading never probes a provider endpoint. */
export function ProviderDirectory({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [rows, setRows] = useState<DirectoryRow[]>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [adding, setAdding] = useState(false)
  const [saved, setSaved] = useState(false)
  const save = async (command: ProviderCommand) => {
    setSaved(false)
    await bridge.request({ kind: "desktop/provider/mutate", workspaceId, command })
    useUiStore.setState((state) => ({ providerRevision: state.providerRevision + 1 }))
    setSaved(true)
    setReload((value) => value + 1)
  }
  useEffect(() => {
    let active = true
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
    <button onClick={() => setAdding(true)}>{t("新增提供商")}</button>
    {saved ? <p role="status">{t("設定已儲存")}</p> : null}
    {adding ? <ProviderEditor onSave={save} onClose={() => setAdding(false)} /> : null}
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></div> : null}
    {rows === undefined ? error ? null : <p role="status">{t("讀取提供商目錄中…")}</p>
      : rows.length === 0 ? <p>{t("沒有可用的提供商")}</p>
      : rows.map((row) => <ProviderCard key={row.id} row={row} onSave={save} bridge={bridge} workspaceId={workspaceId} />)}
  </section>
}
