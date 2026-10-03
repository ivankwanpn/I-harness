import type { CodeModeSettingsView, ExecutionRequest, CodeMode } from "@i-harness/desktop-gateway/src/execution.ts"
import { useExecutionSurface } from "../session/execution-surface.ts"
import { useExecutionText } from "../session/execution-i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"

export function CodeModeSettings({ bridge, workspaceId, sessionId }: { bridge: { request(request: ExecutionRequest): Promise<unknown> }; workspaceId: string; sessionId?: string }) {
  const t = useExecutionText()
  const view = useExecutionSurface<CodeModeSettingsView>(() => bridge.request({ kind: "desktop/code-mode/state", workspaceId, ...(sessionId ? { sessionId } : {}) }), `${workspaceId}:${sessionId ?? ""}`)
  return <section aria-label="Code Mode">
    <h2>Code Mode</h2>
    <SettingsGroup><SettingsRow label="Code Mode" description={t("儲存後套用到新執行環境及新子代理。現有環境與正在執行的 cell 保持原模式。")}
      control={<select aria-label="Code Mode" value={view.state?.saved.mode ?? "off"} disabled={!view.state || view.busy} onChange={event => {
        const mode = event.target.value as CodeMode
        void view.act(() => bridge.request({ kind: "desktop/code-mode/configure", workspaceId, ...(sessionId ? { sessionId } : {}), patch: { mode } }))
      }}><option value="off">off — {t("直接呼叫工具")}</option><option value="mixed">mixed — {t("直接工具與程式編排")}</option><option value="only">only — {t("透過程式呼叫工具")}</option></select>} />
      {view.state?.effective ? <p role="status">{t("目前有效模式")}：<strong>{view.state.effective}</strong>{view.state.effective !== view.state.saved.mode ? ` · ${t("新設定將於新執行環境生效")}` : ""}</p> : <p role="status">{t("目前沒有活躍執行環境")}</p>}
    </SettingsGroup>
    {view.error ? <p role="alert" className="error-text">{view.error}</p> : null}
    <button disabled={view.busy} onClick={() => { void view.refresh() }}>{t("重新整理")}</button>
  </section>
}
