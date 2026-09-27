import { useEffect, useRef, useState } from "react"
import { Server, Plus } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { useUiStore } from "../shell/ui-store.ts"
import { ProviderCard, type DirectoryRow } from "./ProviderCard.tsx"
import { ProviderEditor } from "./ProviderEditor.tsx"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"

/** Displays the backend directory; loading never probes a provider endpoint. */
export function ProviderDirectory({ bridge, workspaceId, showHeading = true }: { bridge: DesktopBridge; workspaceId: string; showHeading?: boolean }) {
  return <ProviderDirectoryContent key={workspaceId} bridge={bridge} workspaceId={workspaceId} showHeading={showHeading} />
}

function ProviderDirectoryContent({ bridge, workspaceId, showHeading }: { bridge: DesktopBridge; workspaceId: string; showHeading: boolean }) {
  const t = useText()
  const [rows, setRows] = useState<DirectoryRow[]>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [adding, setAdding] = useState(false)
  const [addingBusy, setAddingBusy] = useState(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const [saved, setSaved] = useState(false)
  const [capabilityNotice, setCapabilityNotice] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleRows = rows?.filter((row) => !normalizedQuery || `${row.displayName} ${row.id}`.toLocaleLowerCase().includes(normalizedQuery))
  const selected = visibleRows?.find((row) => row.id === selectedId) ?? visibleRows?.find((row) => row.configured) ?? visibleRows?.[0]
  const save = async (command: ProviderCommand) => {
    setSaved(false)
    await bridge.request({ kind: "desktop/provider/mutate", workspaceId, command })
    useUiStore.setState((state) => ({ providerRevision: state.providerRevision + 1 }))
    setSaved(true)
    setQuery("")
    if (command.action === "provider/create") setSelectedId(command.id)
    if ("fields" in command && "inputModalities" in command.fields) setCapabilityNotice(true)
    setReload((value) => value + 1)
  }
  const closeAdding = () => {
    setAdding(false)
    setTimeout(() => addTrigger.current?.focus(), 0)
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
  return <section className="provider-directory" aria-label={t("模型與提供商")}>
    <header className="provider-directory-heading">{showHeading ? <h2>{t("模型與提供商")}</h2> : <span />}
    <Button variant="secondary" size="small" icon={<Plus size={16} />} onClick={(event) => { addTrigger.current = event.currentTarget; setAddingBusy(false); setAdding(true) }}>{t("新增提供商")}</Button></header>
    {saved ? <p role="status">{t("設定已儲存")}</p> : null}
    {capabilityNotice ? <p className="provider-capability-notice" role="status">{t("輸入類型已更新；現有會話請在模型選擇器重新套用模型，之後才會使用更新後的能力。")}</p> : null}
    {adding ? <SettingsDialog title={t("新增提供商")} closeLabel={t("關閉新增提供商")} busy={addingBusy} onClose={closeAdding} initialFocusSelector=".provider-editor input:not(:disabled)"><ProviderEditor onSave={save} onClose={closeAdding} onBusyChange={setAddingBusy} /></SettingsDialog> : null}
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></div> : null}
    {rows === undefined ? error ? null : <p role="status">{t("讀取提供商目錄中…")}</p>
      : rows.length === 0 ? <p>{t("沒有可用的提供商")}</p>
      : <>{rows.length > 1 ? <div className="provider-directory-search"><SearchInput aria-label={t("搜尋提供商")} placeholder={t("搜尋提供商")} value={query} onChange={(event) => setQuery(event.target.value)} clearLabel={t("清除提供商搜尋")} onClear={() => setQuery("")} /></div> : null}<div className="provider-directory-layout">
        <nav className="provider-list" aria-label={t("模型與提供商")}>
          {visibleRows?.length ? visibleRows.map((row) => <button key={row.id} aria-current={selected?.id === row.id ? "true" : undefined} onClick={() => { setSelectedId(row.id); setSaved(false) }}>
            <Server size={16} aria-hidden="true" /><span>{row.displayName}<small>{row.id}</small></span>
          </button>) : <p className="muted">{t("沒有符合的提供商")}</p>}
        </nav>
        <div className="provider-detail">{selected ? <ProviderCard key={`${selected.id}:${selected.baseURL ?? ""}:${selected.protocol ?? ""}`} row={selected} onSave={save} bridge={bridge} workspaceId={workspaceId} /> : null}</div>
      </div></>}
  </section>
}
