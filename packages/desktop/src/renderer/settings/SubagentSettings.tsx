import { useEffect, useId, useRef, useState } from "react"
import type { SubagentSettingsCommand, SubagentSettingsState } from "@i-harness/desktop-gateway/src/subagent-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
type Row = SubagentSettingsState["roles"][number]
interface Route { id: string; displayName: string; models: { id: string }[] }

export function SubagentSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<SubagentSettingsState>()
  const [routes, setRoutes] = useState<Route[]>([])
  const [editing, setEditing] = useState<Row>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const lock = useRef(false)
  const version = useRef(0)
  useEffect(() => {
    let active = true
    const current = ++version.current
    setError(undefined)
    void Promise.all([bridge.request({ kind: "desktop/subagents/state", workspaceId }), bridge.request({ kind: "desktop/provider/directory", workspaceId })]).then(([value, directory]) => {
      if (active && current === version.current) { setState(value as SubagentSettingsState); setRoutes(directory as Route[]) }
    }).catch((reason: unknown) => { if (active && current === version.current) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  async function save(command: SubagentSettingsCommand) {
    if (lock.current) return
    ++version.current
    lock.current = true; setBusy(true); setError(undefined); setNotice(false)
    try {
      setState(await bridge.request({ kind: "desktop/subagents/mutate", workspaceId, command }) as SubagentSettingsState)
      if (command.action !== "enable") { setEditing(undefined); setNotice(true) }
    } catch (reason) { setError(String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section aria-label={t("子代理")}>
    <p className="settings-description">{t("未覆寫時沿用角色定義；內建角色預設繼承主會話。模型配置在下一次建立子代理時讀取，不會更換已執行中的子代理。")}</p>
    {error ? <p role="alert">{error}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></p> : null}
    {!state ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <>
      <SettingsGroup><SettingsRow label={t("允許角色使用獨立模型")} description={t("這個開關重啟 Desktop 後生效。關閉時，後端會拒絕使用已指定模型的角色。")}
        control={<input type="checkbox" aria-label={t("允許角色使用獨立模型")} checked={state.enabled} disabled={busy} onChange={(event) => { void save({ action: "enable", enabled: event.target.checked }) }} />} /></SettingsGroup>
      <p className="muted">{t("目前生效")}：{t(state.effectiveEnabled ? "已啟用" : "已停用")}</p>
      {state.restartRequired ? <p role="status">{t("重啟 Desktop 後套用；目前執行中的 Agent 保持原設定。")}</p> : null}
      {notice ? <p role="status">{t("角色設定已儲存，下一個新子代理會讀取此設定。")}</p> : null}
      <div className="provider-directory-heading"><h2>{t("角色模型")}</h2><button disabled={busy} onClick={() => setEditing({ name: "" })}>{t("新增角色配置")}</button></div>
      {editing ? <RoleEditor key={editing.name} row={editing} routes={routes} busy={busy} onSave={save} onClose={() => setEditing(undefined)} /> : null}
      <SettingsGroup>{state.roles.map((row) => <SettingsRow key={row.name} label={row.name} description={row.selection ? `${row.selection.provider} / ${row.selection.model}` : t("繼承主會話模型")} control={<div className="provider-actions"><button disabled={busy} onClick={() => setEditing(row)}>{t("設定角色模型")}</button>{row.selection ? <button disabled={busy} onClick={() => { void save({ action: "role/clear", role: row.name }) }}>{t("移除模型覆寫")}</button> : null}</div>} />)}</SettingsGroup>
    </>}
  </section>
}

function RoleEditor({ row, routes, busy, onSave, onClose }: { row: Row; routes: Route[]; busy: boolean; onSave(command: SubagentSettingsCommand): Promise<void>; onClose(): void }) {
  const t = useText(); const listId = useId()
  const [name, setName] = useState(row.name)
  const [provider, setProvider] = useState(row.selection?.provider ?? "")
  const [model, setModel] = useState(row.selection?.model ?? "")
  const [effort, setEffort] = useState(row.selection?.reasoningEffort ?? "")
  const [protocol, setProtocol] = useState(row.selection?.protocol ?? "")
  return <form className="provider-editor" onSubmit={(event) => {
    event.preventDefault()
    void onSave({ action: "role/set", role: name, selection: { provider, model, ...(protocol ? { protocol: protocol as NonNullable<Row["selection"]>["protocol"] } : {}), ...(effort ? { reasoningEffort: effort } : {}) } })
  }}><fieldset disabled={busy}><legend>{t("設定角色模型")}</legend>
    <label>{t("角色名稱")}<input required maxLength={128} disabled={Boolean(row.name)} value={name} onChange={(event) => setName(event.target.value)} /></label>
    {!row.name ? <p className="muted">{t("填入既有角色名稱；此設定不會建立新的角色或工具權限。")}</p> : null}
    <label>{t("提供商 ID")}<select required value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); setProtocol("") }}><option value="">{t("未指定")}</option>{provider && !routes.some((route) => route.id === provider) ? <option value={provider}>{provider}</option> : null}{routes.map((route) => <option key={route.id} value={route.id}>{route.displayName}</option>)}</select></label>
    <label>{t("模型 ID")}<input required maxLength={256} list={listId} value={model} onChange={(event) => setModel(event.target.value)} /></label>
    <datalist id={listId}>{routes.find((route) => route.id === provider)?.models.map((model) => <option key={model.id} value={model.id} />)}</datalist>
    <label>{t("推理強度")}<input maxLength={64} value={effort} placeholder={t("未指定")} onChange={(event) => setEffort(event.target.value)} /></label>
    <label>{t("通訊協定")}<select value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="">{t("未指定")}</option>{["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"].map((value) => <option key={value}>{value}</option>)}</select></label>
    <div className="provider-actions"><button type="submit" className="primary-button">{t(busy ? "儲存中…" : "儲存")}</button><button type="button" onClick={onClose}>{t("取消")}</button></div>
  </fieldset></form>
}
