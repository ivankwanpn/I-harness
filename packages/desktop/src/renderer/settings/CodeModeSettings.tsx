import { RefreshCw } from "lucide-react"
import type { CodeModeSettingsView, ExecutionRequest, CodeMode } from "@i-harness/desktop-gateway/src/execution.ts"
import { useExecutionSurface } from "../session/execution-surface.ts"
import { codeModeLabels, useExecutionText } from "../session/execution-i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function CodeModeSettings({ bridge, workspaceId, sessionId }: { bridge: { request(request: ExecutionRequest): Promise<unknown> }; workspaceId: string; sessionId?: string }) {
  const t = useExecutionText()
  const view = useExecutionSurface<CodeModeSettingsView>(() => bridge.request({ kind: "desktop/code-mode/state", workspaceId, ...(sessionId ? { sessionId } : {}) }), `${workspaceId}:${sessionId ?? ""}`)
  const effective = view.state?.effective
  return <section aria-label="Code Mode">
    <div className="code-mode-settings-header"><h2>Code Mode</h2><Button variant="ghost" size="small" disabled={view.busy} icon={<RefreshCw size={14} />} onClick={() => { void view.refresh() }}>{t("重新整理")}</Button></div>
    <SettingsGroup>
      <SettingsRow label={t("新執行環境的模式")} description={t("儲存後套用到新執行環境及新子代理。現有環境與正在執行的 cell 保持原模式。")}
      control={<select aria-label="Code Mode" value={view.state?.saved.mode ?? ""} disabled={!view.state || view.busy} onChange={event => {
        const mode = event.target.value as CodeMode
        void view.act(() => bridge.request({ kind: "desktop/code-mode/configure", workspaceId, ...(sessionId ? { sessionId } : {}), patch: { mode } }))
      }}>
        {!view.state ? <option value="">{view.error ? t("未設定") : t("正在讀取…")}</option> : null}
        {Object.entries(codeModeLabels).map(([mode, label]) => <option key={mode} value={mode}>{t(label)}</option>)}
      </select>} />
      {view.state ? <SettingsRow label={t("目前有效模式")}
        description={effective && effective !== view.state.saved.mode ? t("新設定將於新執行環境生效") : undefined}
        control={<span role="status" className="code-mode-settings-state">{view.busy ? t("儲存設定中…") : effective ? t(codeModeLabels[effective]) : t("目前沒有活躍執行環境")}</span>} /> : null}
    </SettingsGroup>
    {view.error ? <p role="alert" className="error-text">{view.error}</p> : null}
  </section>
}
