import { useEffect, useRef, useState } from "react"
import type { HookSettingsCommand, HookSettingsState } from "@i-harness/desktop-gateway/src/hook-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useAuthoringText } from "./resource-authoring-text.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import type { HookAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/hook-authoring.ts"
import { HookAuthoringEditor } from "./HookAuthoringEditor.tsx"
import { SettingsDraftScope } from "./settings-drafts.tsx"
import "./hook-diagnostics.css"

interface HookSettingsProps { bridge: DesktopBridge; workspaceId: string; onAuthoringRequest?: HookAuthoringRequestHandler; active?: boolean }
export function HookSettings(props: HookSettingsProps) {
  return <SettingsDraftScope owner={props.bridge}><HookSettingsContent key={props.workspaceId} {...props} /></SettingsDraftScope>
}
function HookSettingsContent({ bridge, workspaceId, onAuthoringRequest, active = true }: HookSettingsProps) {
  const t = useAuthoringText()
  const [state, setState] = useState<HookSettingsState>()
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState<HookSettingsState["handlers"][number]>()
  const [busy, setBusy] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editorVisited, setEditorVisited] = useState(false)
  const lock = useRef(false)
  const scope = useRef(workspaceId), version = useRef(0)
  if (scope.current !== workspaceId) { scope.current = workspaceId; ++version.current }
  useEffect(() => {
    let active = true
    lock.current = true; setBusy(true); setState(undefined); setConfirm(undefined); setError(undefined)
    void bridge.request({ kind: "desktop/hooks/state", workspaceId }).then((value) => { if (active) setState(value as HookSettingsState) }).catch((reason: unknown) => { if (active) setError(String(reason)) }).finally(() => { if (active) { lock.current = false; setBusy(false) } })
    return () => { active = false }
  }, [bridge, workspaceId])
  async function run(action: "state" | "refresh" | HookSettingsCommand) {
    if (lock.current) return
    const token = version.current
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const value = await bridge.request(typeof action === "string" ? { kind: action === "state" ? "desktop/hooks/state" : "desktop/hooks/refresh", workspaceId } : { kind: "desktop/hooks/mutate", workspaceId, command: action })
      if (token !== version.current) return
      setState(value as HookSettingsState); setConfirm(undefined)
    } catch (reason) { if (token === version.current) setError(String(reason)) }
    finally { if (token === version.current) { lock.current = false; setBusy(false) } }
  }
  return <section hidden={!active} aria-label={t("Hooks 信任")}>
    <p className="settings-description">{t("插件啟用不等於 Hooks 授權。原生腳本依腳本雜湊授權；Claude 插件 Hooks 依整個插件內容雜湊授權，涵蓋腳本及資源。撤銷會影響使用相同內容的處理器。")}</p>
    <div className="provider-actions"><button disabled={busy} onClick={() => { void run("refresh") }}>{t("重新套用 Hooks")}</button>{onAuthoringRequest ? <button disabled={busy} onClick={() => { setEditorVisited(true); setEditing(!editing) }}>{t(editing ? "關閉本機 Hooks 編輯器" : "編輯本機 Hooks")}</button> : null}</div>
    {editorVisited && onAuthoringRequest ? <div hidden={!editing}><HookAuthoringEditor active={active && editing} workspaceId={workspaceId} request={onAuthoringRequest} onSaved={() => { void run("state") }} /></div> : null}
    {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => { void run(state ? "refresh" : "state") }}>{t("重試")}</button></p> : null}
    {busy ? <p role="status">{t("正在處理…")}</p> : null}
    {confirm ? <div className="hook-confirmation" role="group" aria-label={t("確認授權此內容")}>
      <h2>{t("確認授權此內容")}</h2>
      {confirm.trustScope === "plugin" ? <><p>{t("此授權涵蓋整個插件內容，包括腳本及資源；插件內容變更後需重新審查及授權。")}</p>{confirm.pluginRoot ? <p>{t("插件目錄：{path}", { path: confirm.pluginRoot })}</p> : null}<p>{confirm.configPath}</p></> : null}
      <p>{confirm.script}</p><code>{confirm.sha256}</code>
      <p>{confirm.pluginName ?? confirm.name} · {confirm.sourceEvent ?? confirm.event}</p>{confirm.command ? <pre className="tool-output">{JSON.stringify(confirm.command, null, 2)}</pre> : null}{confirm.configRevision ? <p><code>{confirm.configRevision}</code></p> : null}
      <p>{t(confirm.trustScope === "plugin" ? "授權後，使用同一插件內容及設定的已支援處理器可在各自宣告的事件執行。已開始的操作可繼續完成。" : "授權後，對應的 Hook 可在其宣告事件執行。已開始的操作可繼續完成。")}</p>
      <div className="provider-actions"><button className="primary-button" disabled={busy} onClick={() => { void run({ action: "approve", id: confirm.id, sha256: confirm.sha256 }) }}>{t("確認授權此內容")}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button></div>
    </div> : null}
    {state ? <>
      <h2>{t("目前有效的 Hooks")}</h2>
      {!state.handlers.length && !state.errors.length ? <p className="muted">{t("目前沒有已啟用插件宣告的 Hooks。")}</p> : null}
      {state.errors.map((row, index) => {
        const unsupportedHandler = row.kind === "unsupported-handler"
        const unsupported = row.kind === "unsupported-format" || unsupportedHandler
        const source = row.source === "plugin" ? t("插件") : row.source === "global" ? t("全域") : row.source === "workspace" ? t("專案") : undefined
        return <div role={unsupported ? "note" : "alert"} className="hook-format-diagnostic" key={JSON.stringify([row.configPath, row.handlerId, row.event, index])}>
          <strong>{t(unsupportedHandler ? "此 Hook 處理器尚未連接" : unsupported ? "不支援的 Hook 格式" : "Hook 設定無效")}</strong>
          <div className="hook-format-metadata">
            {source ? <span>{t("來源：{source}", { source })}</span> : null}
            {row.format === "claude-plugin" ? <span>{t("格式：{format}", { format: t("Claude 插件格式") })}</span> : null}
            {row.event ? <span>{t("事件：{event}", { event: row.event })}</span> : null}
            {row.handlerId ? <span>{t("處理器：{id}", { id: row.handlerId })}</span> : null}
          </div>
          <p>{t(unsupportedHandler ? "此診斷只適用於列出的處理器；已支援的插件 Hooks 仍可載入及授權。" : unsupported ? "此 Hooks 設定無法以目前的載入方式使用；請查看來源與診斷。" : row.format === "claude-plugin" && row.source !== "plugin" ? "此本機設定需使用原生 v1 格式；Claude 插件 Hooks 由插件載入。" : "請修正設定後重新套用 Hooks。")}</p>
          <details><summary>{t("來源與診斷")}</summary><code>{row.configPath}</code><pre>{row.message}</pre></details>
        </div>
      })}
      {state.handlers.map((row) => <SettingsGroup key={row.id}>
        <SettingsRow label={row.pluginName ?? row.name} description={row.format === "claude-plugin" ? t("Claude 插件 · {event}", { event: row.sourceEvent ?? row.event }) : row.event} control={<span>{t(row.status === "ready" ? "信任檢查通過" : row.status === "needs-approval" ? row.trustScope === "plugin" ? "等待插件內容授權" : "等待腳本授權" : row.trustScope === "plugin" ? "插件內容或設定無效" : "腳本或設定無效")}</span>} />
        <div className="hook-details"><p>{row.script}</p><code>{row.sha256}</code><details><summary>{t("來源與診斷")}</summary><p>{row.configPath}</p>
          {row.pluginName ? <p>{row.name}</p> : null}
          {row.format === "claude-plugin" ? <>{row.pluginRoot ? <p>{t("插件目錄：{path}", { path: row.pluginRoot })}</p> : null}{row.command ? <pre className="tool-output">{JSON.stringify(row.command, null, 2)}</pre> : null}{row.configRevision ? <p><code>{row.configRevision}</code></p> : null}</> : null}
          {row.error ? <p>{row.error}</p> : null}</details>
          {row.trustScope === "plugin" ? <p>{t("此雜湊涵蓋插件的腳本及資源。")}</p> : null}
          {row.status === "needs-approval" ? <button className="primary-button" disabled={busy} onClick={() => setConfirm(row)}>{t(row.trustScope === "plugin" ? "審查插件內容" : "批准腳本")}</button> : null}
        </div>
      </SettingsGroup>)}
      <h2>{t("已保存的 Hooks 授權")}</h2>
      <SettingsGroup>{state.grants.map((grant) => <SettingsRow key={grant.sha256} label={grant.handlerId || grant.sha256} description={`${grant.script} · ${grant.sha256}`} control={<button disabled={busy} onClick={() => { void run({ action: "revoke", sha256: grant.sha256 }) }}>{t("撤銷授權")}</button>} />)}</SettingsGroup>
      {!state.grants.length ? <p className="muted">{t("沒有已保存的 Hooks 授權")}</p> : null}
    </> : null}
  </section>
}
