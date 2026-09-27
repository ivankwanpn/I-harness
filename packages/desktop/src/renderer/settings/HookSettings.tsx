import { useEffect, useRef, useState } from "react"
import type { HookSettingsCommand, HookSettingsState } from "@i-harness/desktop-gateway/src/hook-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function HookSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<HookSettingsState>()
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState<HookSettingsState["handlers"][number]>()
  const [busy, setBusy] = useState(true)
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    lock.current = true
    void bridge.request({ kind: "desktop/hooks/state", workspaceId }).then((value) => { if (active) setState(value as HookSettingsState) }).catch((reason: unknown) => { if (active) setError(String(reason)) }).finally(() => { lock.current = false; if (active) setBusy(false) })
    return () => { active = false }
  }, [bridge, workspaceId])
  async function run(action: "state" | "refresh" | HookSettingsCommand) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const value = await bridge.request(typeof action === "string" ? { kind: action === "state" ? "desktop/hooks/state" : "desktop/hooks/refresh", workspaceId } : { kind: "desktop/hooks/mutate", workspaceId, command: action })
      setState(value as HookSettingsState); setConfirm(undefined)
    } catch (reason) { setError(String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section aria-label={t("Hooks 信任")}>
    <p className="settings-description">{t("插件啟用不等於腳本授權。授權依腳本內容雜湊共用；撤銷會影響使用相同內容的處理器。")}</p>
    <div className="provider-actions"><button disabled={busy} onClick={() => { void run("refresh") }}>{t("重新套用 Hooks")}</button></div>
    {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => { void run(state ? "refresh" : "state") }}>{t("重試")}</button></p> : null}
    {busy ? <p role="status">{t("正在處理…")}</p> : null}
    {confirm ? <div className="hook-confirmation" role="group" aria-label={t("確認授權此內容")}>
      <h2>{t("確認授權此內容")}</h2><p>{confirm.script}</p><code>{confirm.sha256}</code>
      <p>{t("授權後，對應的 Hook 可在其宣告事件執行。已開始的操作可繼續完成。")}</p>
      <div className="provider-actions"><button className="primary-button" disabled={busy} onClick={() => { void run({ action: "approve", id: confirm.id, sha256: confirm.sha256 }) }}>{t("確認授權此內容")}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button></div>
    </div> : null}
    {state ? <>
      <h2>{t("已啟用插件的 Hooks")}</h2>
      {!state.handlers.length && !state.errors.length ? <p className="muted">{t("目前沒有已啟用插件宣告的 Hooks。")}</p> : null}
      {state.errors.map((row) => <div role="alert" className="notice" key={row.configPath}><strong>{row.configPath}</strong><p>{row.message}</p></div>)}
      {state.handlers.map((row) => <SettingsGroup key={row.id}>
        <SettingsRow label={row.name} description={row.event} control={<span>{t(row.status === "ready" ? "信任檢查通過" : row.status === "needs-approval" ? "等待腳本授權" : "腳本或設定無效")}</span>} />
        <div className="hook-details"><p>{row.script}</p><code>{row.sha256}</code><details><summary>{t("來源與診斷")}</summary><p>{row.configPath}</p>{row.error ? <p>{row.error}</p> : null}</details>
          {row.status === "needs-approval" ? <button className="primary-button" disabled={busy} onClick={() => setConfirm(row)}>{t("批准腳本")}</button> : null}
        </div>
      </SettingsGroup>)}
      <h2>{t("已保存的腳本授權")}</h2>
      <SettingsGroup>{state.grants.map((grant) => <SettingsRow key={grant.sha256} label={grant.handlerId || grant.sha256} description={`${grant.script} · ${grant.sha256}`} control={<button disabled={busy} onClick={() => { void run({ action: "revoke", sha256: grant.sha256 }) }}>{t("撤銷授權")}</button>} />)}</SettingsGroup>
      {!state.grants.length ? <p className="muted">{t("沒有已保存的腳本授權")}</p> : null}
    </> : null}
  </section>
}
