import { useEffect, useRef, useState } from "react"
import type { AgentDefaults, AgentSettingsState } from "@i-harness/desktop-gateway/src/agent-settings.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function AgentSettings({ bridge, workspaceId, onSandboxChange }: { bridge: DesktopBridge; workspaceId: string; onSandboxChange?(mode: AgentDefaults["sandboxMode"]): void }) {
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
  const approvalModes = ["dangerous", "ask-all", "delegate", "full-access"] as const
  const approvalLabels = { dangerous: "僅危險操作詢問", "ask-all": "逐項詢問", delegate: "代我審批", "full-access": "完整存取權" } as const
  const changed = state && draft && (state.saved.sandboxMode !== draft.sandboxMode || state.saved.autoCompaction !== draft.autoCompaction || state.saved.approvalMode !== draft.approvalMode)
  return <section aria-label={t("執行與上下文")}>
    <p className="settings-description">{t("設定儲存後即時生效：沙箱與核準模式套用到下一次工具呼叫，自動壓縮套用到下一個步驟；已顯示的核準仍須手動決定。")}</p>
    {error ? <p role="alert" className="error-text">{error}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重試")}</button></p> : null}
    {!state || !draft ? !error ? <p role="status">{t("正在讀取…")}</p> : null : <form onSubmit={(event) => {
      event.preventDefault()
      if (lock.current || !changed) return
      const patch: Partial<AgentDefaults> = {}
      if (draft.sandboxMode !== state.saved.sandboxMode) patch.sandboxMode = draft.sandboxMode
      if (draft.autoCompaction !== state.saved.autoCompaction) patch.autoCompaction = draft.autoCompaction
      if (draft.approvalMode !== state.saved.approvalMode) patch.approvalMode = draft.approvalMode
      lock.current = true; setBusy(true); setError(undefined)
      void bridge.request({ kind: "desktop/agent-settings/configure", workspaceId, patch }).then((value) => {
        const next = value as AgentSettingsState; setState(next); setDraft(next.saved)
        if (next.effective.sandboxMode !== state.effective.sandboxMode) onSandboxChange?.(next.effective.sandboxMode)
      }).catch((reason: unknown) => setError(String(reason))).finally(() => { lock.current = false; setBusy(false) })
    }}>
      <SettingsGroup>
        <SettingsRow label={t("沙箱")} description={t("控制 Agent 工具可存取的範圍。")}
          control={<select aria-label={t("沙箱")} disabled={busy} value={draft.sandboxMode} onChange={(event) => { const sandboxMode = event.target.value as AgentDefaults["sandboxMode"]; setDraft({ ...draft, sandboxMode, approvalMode: draft.approvalMode === "full-access" && sandboxMode !== "danger-full-access" ? "dangerous" : draft.approvalMode }) }}>{modes.map((mode) => <option key={mode} value={mode}>{t(labels[mode])}</option>)}</select>} />
        <SettingsRow label={t("核準模式")} description={t("危險模式只詢問高風險或無法判定的操作；代審使用模型檢查每項工具請求，仍可能交由你決定。完整存取權會一併設定完整存取沙箱。")}
          control={<select aria-label={t("核準模式")} disabled={busy} value={draft.approvalMode} onChange={(event) => { const approvalMode = event.target.value as AgentDefaults["approvalMode"]; setDraft({ ...draft, approvalMode, ...(approvalMode === "full-access" ? { sandboxMode: "danger-full-access" as const } : {}) }) }}>{approvalModes.map((mode) => <option key={mode} value={mode}>{t(approvalLabels[mode])}</option>)}</select>} />
        <SettingsRow label={t("自動壓縮上下文")} description={t("依模型的上下文大小自動整理內容；關閉後仍可手動壓縮。")}
          control={<input type="checkbox" aria-label={t("自動壓縮上下文")} disabled={busy} checked={draft.autoCompaction} onChange={(event) => setDraft({ ...draft, autoCompaction: event.target.checked })} />} />
      </SettingsGroup>
      <div className="settings-save-bar"><button type="submit" className="primary-button" disabled={busy || !changed}>{t(busy ? "儲存中…" : "儲存")}</button>{changed ? <button type="button" disabled={busy} onClick={() => setDraft(state.saved)}>{t("取消")}</button> : null}</div>
      {state.restartRequired ? <p role="status" className="notice">{t("部分設定尚未套用，請重新讀取目前生效的設定。")}</p> : null}
      <h2>{t("目前生效")}</h2>
      <SettingsGroup><SettingsRow label={t("沙箱")} control={<span>{t(labels[state.effective.sandboxMode])}</span>} /><SettingsRow label={t("核準模式")} control={<span>{t(approvalLabels[state.effective.approvalMode])}</span>} /><SettingsRow label={t("自動壓縮上下文")} control={<span>{t(state.effective.autoCompaction ? "已啟用" : "已停用")}</span>} /></SettingsGroup>
    </form>}
  </section>
}
