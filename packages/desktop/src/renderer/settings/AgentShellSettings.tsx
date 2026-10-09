import { useEffect, useRef, useState } from "react"
import type { AgentShellSettingsState } from "@i-harness/desktop-gateway/src/agent-shell.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function AgentShellSettings({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [state, setState] = useState<AgentShellSettingsState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const version = useRef(0)
  const lock = useRef(false)
  useEffect(() => {
    const current = ++version.current
    setState(undefined); setError(undefined); setBusy(false); lock.current = false
    void bridge.request({ kind: "desktop/agent-shell/state", workspaceId }).then((value) => {
      if (current === version.current) setState(value as AgentShellSettingsState)
    }).catch((reason: unknown) => { if (current === version.current) setError(String(reason)) })
    return () => { ++version.current }
  }, [bridge, workspaceId, reload])
  const available = state?.options ?? []
  const visible = state && !available.some((option) => option.id === state.selected)
    ? [...available, { id: state.selected, label: t("已選擇的 Shell 目前不可用") }] : available
  return <>
    <h2>{t("Agent Shell")}</h2>
    <SettingsGroup><SettingsRow label={t("Agent Shell")} description={t(state?.executionTarget === "wsl" ? "WSL 新組裝使用所選發行版的 Linux Bash 與 Linux 路徑；既有組裝保留原 Shell。原生 PowerShell 工具與人類終端仍在 Windows 主機執行。可在執行設定診斷 WSL。" : "儲存後套用到下一個 Agent 命令；正在執行或等候核準的命令保持原 Shell。使用所選 Shell 的命令語法。")}
      control={<select aria-label={t("Agent Shell")} value={state?.selected ?? "auto"} disabled={busy || !state || available.length === 0 || state.executionTarget === "wsl"} onChange={(event) => {
        if (lock.current) return
        lock.current = true; setBusy(true); setError(undefined)
        const current = version.current
        void bridge.request({ kind: "desktop/agent-shell/configure", workspaceId, patch: { shell: event.target.value as AgentShellSettingsState["selected"] } }).then((value) => {
          if (current === version.current) setState(value as AgentShellSettingsState)
        }).catch((reason: unknown) => { if (current === version.current) setError(String(reason)) })
          .finally(() => { if (current === version.current) { lock.current = false; setBusy(false) } })
      }}>{visible.map((option) => <option key={option.id} value={option.id}>{option.id === "auto" ? t("自動選擇") : option.label}</option>)}</select>} />
      {state?.resolved ? <p className="settings-shell-path" role="status">{t(state.executionTarget === "wsl" ? "新組裝使用的 Linux 執行檔" : "目前執行檔")}：<code>{state.resolved.command}</code></p> : null}
    </SettingsGroup>
    {!state && !error ? <p role="status">{t("正在讀取…")}</p> : null}
    {error || state?.error ? <p role="alert" className="error-text">{error ?? state?.error}<button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("重新整理")}</button></p> : null}
  </>
}
