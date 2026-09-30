import { useEffect, useRef, useState } from "react"
import type { SubagentSettingsCommand, SubagentSettingsState } from "@i-harness/desktop-gateway/src/subagent-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

type Row = SubagentSettingsState["roles"][number]
interface Route { id: string; displayName: string; auth?: { configured: boolean }; protocol?: string; models: { id: string; displayName?: string; protocol?: string }[] }
const efforts = [["", "Default"], ["off", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]] as const
const modelKey = (provider: string, model: string) => JSON.stringify([provider, model])

export function SubagentSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<SubagentSettingsState>()
  const [routes, setRoutes] = useState<Route[]>([])
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<"代審模型已儲存，下一次核準檢查會使用此設定。" | "角色設定已儲存，下一個新子代理會讀取此設定。">()
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [adding, setAdding] = useState(false)
  const [roleName, setRoleName] = useState("")
  const [draftRole, setDraftRole] = useState<string>()
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
    lock.current = true; setBusy(true); setError(undefined); setNotice(undefined)
    try {
      setState(await bridge.request({ kind: "desktop/subagents/mutate", workspaceId, command }) as SubagentSettingsState)
      if (command.action !== "enable") setNotice(command.role === "reviewer"
        ? "代審模型已儲存，下一次核準檢查會使用此設定。"
        : "角色設定已儲存，下一個新子代理會讀取此設定。")
    } catch (reason) { setError(String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  const reviewer = state?.roles.find((row) => row.name === "reviewer") ?? { name: "reviewer" }
  const roles = state?.roles.filter((row) => row.name !== "reviewer") ?? []
  if (draftRole && !state?.roles.some((row) => row.name === draftRole)) roles.push({ name: draftRole })
  return <section aria-label={t("子代理")}>
    <p className="settings-description">{t("未覆寫時沿用角色定義；內建角色預設繼承主會話。模型配置在下一次建立子代理時讀取，不會更換已執行中的子代理。")}</p>
    {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></p> : null}
    {!state ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <>
      {notice ? <p role="status">{t(notice)}</p> : null}
      <h2>{t("代我審批")}</h2>
      <p className="muted">{t("代審模型獨立於任務子代理開關；未指定時沿用主會話模型。變更會在下一次核準檢查生效。")}</p>
      <RoleCard row={reviewer} title={t("代我審批")} description={t("檢查待核準的操作，無法執行工具。可選擇較便宜的模型。") } routes={routes} busy={busy} onSave={save} />
      <h2>{t("任務子代理")}</h2>
      <SettingsGroup><SettingsRow label={t("允許角色使用獨立模型")} description={t("儲存後立即生效；關閉時會拒絕使用獨立模型的新子代理，已執行中的子代理保持原模型。")}
        control={<input type="checkbox" aria-label={t("允許角色使用獨立模型")} checked={state.enabled} disabled={busy} onChange={(event) => { void save({ action: "enable", enabled: event.target.checked }) }} />} /></SettingsGroup>
      <p className="muted">{t("目前生效")}：{t(state.effectiveEnabled ? "已啟用" : "已停用")}</p>
      {state.restartRequired ? <p role="status">{t("部分設定尚未套用，請重新讀取目前生效的設定。")}</p> : null}
      <div className="provider-directory-heading"><h2>{t("角色模型")}</h2><button disabled={busy} onClick={() => setAdding((value) => !value)}>{t("新增角色配置")}</button></div>
      {adding ? <form className="role-add-form" onSubmit={(event) => {
        event.preventDefault()
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(roleName) || ["constructor", "prototype"].includes(roleName)) return
        setDraftRole(roleName); setAdding(false); setRoleName("")
      }}><label>{t("角色名稱")}<input required maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}" value={roleName} onChange={(event) => setRoleName(event.target.value)} /></label>
        <p className="muted">{t("填入既有角色名稱；此設定不會建立新的角色或工具權限。")}</p><button type="submit">{t("新增角色配置")}</button>
      </form> : null}
      <div className="role-model-list">{roles.map((row) => <RoleCard key={row.name} row={row} routes={routes} busy={busy} onSave={save} />)}</div>
    </>}
  </section>
}

function RoleCard({ row, title = row.name, description, routes, busy, onSave }: { row: Row; title?: string; description?: string; routes: Route[]; busy: boolean; onSave(command: SubagentSettingsCommand): Promise<void> }) {
  const t = useText()
  const current = row.selection
  const route = routes.find((entry) => entry.id === current?.provider)
  const model = route?.models.find((entry) => entry.id === current?.model)
  const configured = route?.auth?.configured !== false
  const resolved = Boolean(model && (current?.protocol || model.protocol || route?.protocol))
  const value = current ? modelKey(current.provider, current.model) : ""
  function selectModel(key: string) {
    if (!key) { void onSave({ action: "role/clear", role: row.name }); return }
    for (const provider of routes) {
      const entry = provider.models.find((candidate) => modelKey(provider.id, candidate.id) === key)
      if (!entry || provider.auth?.configured === false || !(entry.protocol || provider.protocol)) continue
      const same = current?.provider === provider.id && current.model === entry.id
      void onSave({ action: "role/set", role: row.name, selection: { provider: provider.id, model: entry.id,
        ...(same && current?.protocol ? { protocol: current.protocol } : {}),
        ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) } })
      return
    }
  }
  return <article className="role-model-card">
    <div className="role-model-description"><h3>{title}</h3><p className="muted">{description ?? row.description ?? t("繼承主會話模型")}</p></div>
    <label>{t("模型")}<select aria-label={`${t("模型")} ${title}`} disabled={busy} value={value} onChange={(event) => selectModel(event.target.value)}>
      <option value="">{t("繼承主會話模型")}</option>
      {current && !model ? <option value={value} disabled>{`${current.provider} / ${current.model}`} ({t("已不在模型目錄")})</option> : null}
      {routes.map((provider) => <optgroup key={provider.id} label={provider.displayName}>{provider.models.map((entry) => <option key={entry.id} value={modelKey(provider.id, entry.id)} disabled={provider.auth?.configured === false || !(entry.protocol || provider.protocol || current?.provider === provider.id && current.model === entry.id && current.protocol)}>
        {`${provider.displayName} / ${entry.displayName ?? entry.id}`}{provider.auth?.configured === false ? ` · ${t("憑證未設定")}` : ""}
      </option>)}</optgroup>)}
    </select></label>
    <label>{t("推理強度")}<select aria-label={`${t("推理強度")} ${title}`} disabled={busy || !current || !configured || !resolved} value={current?.reasoningEffort ?? ""} onChange={(event) => {
      if (!current) return
      const { reasoningEffort: _, ...selection } = current
      void onSave({ action: "role/set", role: row.name, selection: { ...selection, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) } })
    }}>
      {current?.reasoningEffort && !efforts.some(([effort]) => effort === current.reasoningEffort) ? <option value={current.reasoningEffort}>{current.reasoningEffort}</option> : null}
      {efforts.map(([effort, label]) => <option key={effort} value={effort}>{label}</option>)}
    </select></label>
    {current && (!configured || !resolved) ? <p className="role-model-status muted">{t(!configured ? "此提供商尚未設定憑證，無法供子代理使用。" : "請先在模型與提供商設定通訊協定。")}</p> : null}
  </article>
}
