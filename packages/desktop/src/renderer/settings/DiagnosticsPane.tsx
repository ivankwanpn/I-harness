import type { DiagnosticsRequest, EnvironmentDiagnosticsView } from "@i-harness/desktop-gateway/src/environment-diagnostics.ts"
import { useExecutionSurface } from "../session/execution-surface.ts"
import { useExecutionText } from "../session/execution-i18n.ts"

export function DiagnosticsPane({ bridge, workspaceId, sessionId }: { bridge: { request(request: DiagnosticsRequest): Promise<unknown> }; workspaceId: string; sessionId?: string }) {
  const t = useExecutionText()
  const request = (probe: boolean) => bridge.request({ kind: "desktop/environment/diagnostics", workspaceId, ...(sessionId ? { sessionId } : {}), probe })
  const view = useExecutionSurface<EnvironmentDiagnosticsView>(() => request(false), `${workspaceId}:${sessionId ?? ""}`)
  return <section className="workflow-section" aria-label={t("工具與環境診斷")}>
    <div className="workflow-heading"><h2>{t("工具與環境診斷")}</h2><button disabled={view.busy} onClick={() => { void view.act(() => request(true), value => view.replace(value as EnvironmentDiagnosticsView), false) }}>{t("檢測執行檔版本")}</button></div>
    {view.error ? <div><p role="alert" className="error-text">{view.error}</p><button disabled={view.busy} onClick={() => { void view.refresh() }}>{t("重試")}</button></div> : null}
    {view.state ? <>
      <p>{view.state.live ? t("目前活躍環境") : t("目前沒有活躍執行環境；工具及角色清單於執行環境建立後可讀。")}{view.state.effectiveMode ? ` · Code Mode: ${view.state.effectiveMode}` : ""}</p>
      <h3>{t("實際 Agent Shell")}</h3><p>{view.state.shell?.resolved?.command ?? view.state.shell?.error ?? t("未設定")}</p>
      <h3>{t("執行檔與版本")}</h3><table><thead><tr><th>{t("名稱")}</th><th>{t("狀態")}</th><th>{t("執行檔／版本")}</th></tr></thead><tbody>{view.state.executables.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.status}</td><td><code>{item.command}</code><pre>{item.version ?? item.error}</pre></td></tr>)}</tbody></table>
      <h3>{t("工具宣告與目前模型可见範圍")}</h3><table><thead><tr><th>{t("工具")}</th><th>{t("宣告曝光")}</th><th>{t("目前模型可見")}</th></tr></thead><tbody>{view.state.tools.map(tool => <tr key={tool.name}><td><code>{tool.name}</code></td><td>{tool.exposure}</td><td>{tool.modelVisible ? t("是") : t("否")}</td></tr>)}</tbody></table>
      <h3>{t("角色工具 allowlist")}</h3>{view.state.roles.map(role => <details key={role.name} className="workflow-card"><summary>{role.name}</summary><pre>{role.allowlist.join("\n") || t("空 allowlist")}</pre></details>)}
    </> : !view.error ? <p role="status">{t("正在讀取…")}</p> : null}
  </section>
}
