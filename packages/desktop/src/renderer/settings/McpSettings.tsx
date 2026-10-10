import { useEffect, useRef, useState } from "react"
import type { McpSettingsCommand } from "@i-harness/desktop-gateway/src/mcp-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { McpEditor, type McpState } from "./McpEditor.tsx"
import { SettingsDraftScope, useSettingsDraft } from "./settings-drafts.tsx"
interface McpSettingsProps { bridge: DesktopBridge; workspaceId: string; active?: boolean }
export function McpSettings(props: McpSettingsProps) {
  return <SettingsDraftScope owner={props.bridge}><McpSettingsContent key={props.workspaceId} {...props} /></SettingsDraftScope>
}
function McpSettingsContent({ bridge, workspaceId, active = true }: McpSettingsProps) {
  const t = useText()
  const [state, setState] = useState<McpState>()
  const [editing, setEditing] = useSettingsDraft<string | null | undefined>(["mcp", workspaceId, "editing"], undefined)
  const [confirm, setConfirm] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)
  const lock = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    let active = true; ++generation.current; lock.current = true
    void bridge.request({ kind: "desktop/mcp/state", workspaceId }).then((value) => { if (active) setState(value as McpState) }).catch((reason: unknown) => { if (active) setError(String(reason)) }).finally(() => { lock.current = false; if (active) setBusy(false) })
    return () => { active = false; ++generation.current }
  }, [bridge, workspaceId])
  async function run(command: McpSettingsCommand | "state" | "refresh", propagateError = false) {
    if (lock.current) return
    const token = generation.current
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const value = await bridge.request(typeof command === "string" ? { kind: command === "state" ? "desktop/mcp/state" : "desktop/mcp/refresh", workspaceId } : { kind: "desktop/mcp/mutate", workspaceId, command })
      if (token !== generation.current) return
      setState(value as McpState); setEditing(undefined); setConfirm(undefined)
    } catch (reason) { if (propagateError) throw reason; if (token === generation.current) setError(String(reason)) }
    finally { if (token === generation.current) { lock.current = false; setBusy(false) } }
  }
  async function reloadSource() {
    if (lock.current) throw new Error(t("操作進行中"))
    const token = generation.current
    lock.current = true; setBusy(true)
    try {
      const value = await bridge.request({ kind: "desktop/mcp/state", workspaceId }) as McpState
      if (token === generation.current) setState(value)
      return value.servers.find(row => row.config.serverName === editing)
    } finally { if (token === generation.current) { lock.current = false; setBusy(false) } }
  }
  return <section hidden={!active} aria-label={t("MCP 伺服器")}>
    <p className="settings-description">{t("這些 MCP 設定由本機工作區共用。啟用與停用會套用到現有 Agent；插件提供的 MCP 由插件頁管理。")}</p>
    <div className="provider-actions"><button disabled={busy} onClick={() => setEditing(null)}>{t("新增 MCP 伺服器")}</button><button disabled={busy} onClick={() => { void run("refresh") }}>{t("重新套用")}</button></div>
    {error ? <p role="alert">{error}{!state ? <button disabled={busy} onClick={() => { void run("state") }}>{t("重試")}</button> : null}</p> : null}
    {state?.applyError ? <p role="alert">{state.applyError}<button disabled={busy} onClick={() => { void run("refresh") }}>{t("重試套用")}</button></p> : null}
    {busy ? <p role="status">{t("正在處理…")}</p> : null}
    {editing !== undefined && state ? <McpEditor key={editing ?? "$new"} draftIdentity={["mcp", workspaceId, editing ?? "$new"]} row={state.servers.find((row) => row.config.serverName === editing)} busy={busy} onSave={command => run(command, true)} onReload={reloadSource} onClose={() => setEditing(undefined)} /> : null}
    {state?.servers.length === 0 ? <p className="muted">{t("尚未設定 MCP 伺服器")}</p> : null}
    {state?.servers.map((row) => <SettingsGroup key={row.config.serverName}>
      <SettingsRow label={row.config.serverName} description={row.config.transport === "stdio" ? row.config.command : row.config.url} control={<span>{t(row.enabled ? "設定已啟用" : "已停用")}</span>} />
      <div className="provider-actions"><button disabled={busy} onClick={() => { void run({ action: row.enabled ? "disable" : "enable", name: row.config.serverName }) }}>{t(row.enabled ? "停用" : "啟用")}</button><button disabled={busy} onClick={() => setEditing(row.config.serverName)}>{t("編輯 MCP 設定")}</button><button disabled={busy} onClick={() => { if (confirm === row.config.serverName) void run({ action: "remove", name: row.config.serverName }); else setConfirm(row.config.serverName) }}>{t(confirm === row.config.serverName ? "確認移除 MCP" : "移除")}</button></div>
    </SettingsGroup>)}
    {confirm ? <button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
  </section>
}
