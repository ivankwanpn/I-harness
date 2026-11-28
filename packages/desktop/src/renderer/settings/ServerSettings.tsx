import { useEffect, useState } from "react"
import { Server, RefreshCw } from "lucide-react"
import { DESKTOP_CONFIGURATION_ID } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import type { DesktopBridge, DesktopHostStatus, WorkspaceConnection } from "../../shared/bridge.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { NativeSettings } from "./NativeSettings.tsx"

const labels = { online: "已連線", idle: "待命", connecting: "正在開啟工作區…", offline: "連線已中斷", reconnecting: "重新連線中…" } as const satisfies Record<WorkspaceConnection, string>

export function ServerSettings({ bridge, workspaces }: { bridge: DesktopBridge; workspaces: WorkspaceEntry[] }) {
  const t = useText()
  const [status, setStatus] = useState<DesktopHostStatus>()
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    let sequence = 0
    async function read() {
      const ticket = ++sequence
      try {
        const snapshot = await bridge.request({ kind: "desktop/runtime/host-status" }) as DesktopHostStatus
        if (live && ticket === sequence) { setStatus(snapshot); setError(undefined) }
      } catch (reason) {
        if (live && ticket === sequence) { setStatus(undefined); setError(String(reason)) }
      }
    }
    const unsubscribe = bridge.onEvent(event => {
      if (event.kind === "sdk/ready" || event.kind === "sdk/idle" || event.kind === "sdk/disconnected") void read()
    })
    void read()
    return () => { live = false; unsubscribe() }
  }, [bridge, revision])
  const folders = new Map(workspaces.map(row => [row.id, row]))
  return <>
    <div className="settings-section-heading"><h2><Server size={17} aria-hidden="true" />{t("本機執行主機")}</h2>
      <Button size="small" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => setRevision(value => value + 1)}>{t("更新狀態")}</Button>
    </div>
    {error ? <p role="alert" className="error-text">{error}</p> : !status ? <p role="status">{t("讀取伺服器狀態…")}</p> : <>
      <SettingsGroup><SettingsRow label="I-harness Gateway" description={status.pid ? `PID ${status.pid}` : undefined}
        control={<span>{t(status.process === "standby" ? "待命" : status.process === "stopping" ? "正在停止" : "執行中")}</span>} /></SettingsGroup>
      <h2>{t("工作區連線")}</h2>
      {status.scopes.length ? <SettingsGroup>{status.scopes.map(({ workspaceId, connection }) => <SettingsRow key={workspaceId}
        label={workspaceId === DESKTOP_CONFIGURATION_ID ? t("共用設定服務") : folders.get(workspaceId)?.label ?? workspaceId}
        description={folders.get(workspaceId)?.path} control={<span>{t(labels[connection])}</span>} />)}</SettingsGroup> : <p className="muted">{t("目前沒有工作區連線。")}</p>}
    </>}
    <NativeSettings bridge={bridge} section="terminal" />
  </>
}
