import { useEffect, useRef, useState } from "react"
import type { AgentDefaults, AgentSettingsState } from "@i-harness/desktop-gateway/src/agent-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function AgentSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<AgentSettingsState>()
  const [draft, setDraft] = useState<AgentDefaults>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    setError(undefined)
    void bridge.request({ kind: "desktop/agent-settings/state", workspaceId }).then((value) => {
      if (active) { const next = value as AgentSettingsState; setState(next); setDraft(next.saved) }
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  const modes = ["read-only", "workspace-write", "danger-full-access"] as const
  const labels = { "read-only": "唯讀", "workspace-write": "可寫入工作區", "danger-full-access": "完整存取" } as const
  const changed = state && draft && (state.saved.sandboxMode !== draft.sandboxMode || state.saved.autoCompaction !== draft.autoCompaction)
  return <section aria-label={t("執行與上下文")}>
    <p className="settings-description">{t("這些預設值儲存在共用的本機設定，重啟 Desktop 後生效。")}</p>
    {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></p> : null}
    {!state || !draft ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <form onSubmit={(event) => {
      event.preventDefault()
      if (lock.current || !changed) return
      const patch: Partial<AgentDefaults> = {}
      if (draft.sandboxMode !== state.saved.sandboxMode) patch.sandboxMode = draft.sandboxMode
      if (draft.autoCompaction !== state.saved.autoCompaction) patch.autoCompaction = draft.autoCompaction
      lock.current = true; setBusy(true); setError(undefined)
      void bridge.request({ kind: "desktop/agent-settings/configure", workspaceId, patch }).then((value) => {
        const next = value as AgentSettingsState; setState(next); setDraft(next.saved)
      }).catch((reason: unknown) => setError(String(reason))).finally(() => { lock.current = false; setBusy(false) })
    }}>
      <SettingsGroup>
        <SettingsRow label={t("沙箱")} description={t("控制 Agent 工具可存取的範圍。")}
          control={<select aria-label={t("沙箱")} disabled={busy} value={draft.sandboxMode} onChange={(event) => setDraft({ ...draft, sandboxMode: event.target.value as AgentDefaults["sandboxMode"] })}>{modes.map((mode) => <option key={mode} value={mode}>{t(labels[mode])}</option>)}</select>} />
        <SettingsRow label={t("自動壓縮上下文")} description={t("依模型的上下文大小自動整理內容；關閉後仍可手動壓縮。")}
          control={<input type="checkbox" aria-label={t("自動壓縮上下文")} disabled={busy} checked={draft.autoCompaction} onChange={(event) => setDraft({ ...draft, autoCompaction: event.target.checked })} />} />
      </SettingsGroup>
      <div className="settings-save-bar"><button type="submit" className="primary-button" disabled={busy || !changed}>{t(busy ? "儲存中…" : "儲存")}</button>{changed ? <button type="button" disabled={busy} onClick={() => setDraft(state.saved)}>{t("取消")}</button> : null}</div>
      {state.restartRequired ? <p role="status" className="notice">{t("重啟 Desktop 後套用；目前執行中的 Agent 保持原設定。")}</p> : null}
      <h2>{t("目前生效")}</h2>
      <SettingsGroup><SettingsRow label={t("沙箱")} control={<span>{t(labels[state.effective.sandboxMode])}</span>} /><SettingsRow label={t("自動壓縮上下文")} control={<span>{t(state.effective.autoCompaction ? "已啟用" : "已停用")}</span>} /></SettingsGroup>
    </form>}
  </section>
}
