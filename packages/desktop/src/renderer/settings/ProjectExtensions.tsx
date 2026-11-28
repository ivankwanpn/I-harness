import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import { useText } from "../design/i18n.ts"
import { ExtensionsSettings, type ExtensionTab } from "./ExtensionsSettings.tsx"

export function ProjectExtensions({ bridge, project, workspaces, activeWorkspaceId, onUse }: {
  bridge: DesktopBridge; project: ProjectEntry; workspaces: WorkspaceEntry[]
  activeWorkspaceId?: string; onUse?(prefix: string): void
}) {
  const t = useText()
  const members = workspaces.filter(row => project.workspaceIds.includes(row.id))
  const [selected, setSelected] = useState<string>()
  const workspaceId = members.find(row => row.id === selected)?.id ?? members.find(row => row.id === project.primaryWorkspaceId)?.id ?? members[0]?.id
  const [tab, setTab] = useState<ExtensionTab>("mcp")
  const [revision, setRevision] = useState(0)
  const [scope, setScope] = useState<{ id: string; capabilities?: Record<string, string[]>; error?: string }>()
  useEffect(() => {
    if (!workspaceId) return
    let live = true
    setScope(undefined)
    void bridge.request({ kind: "desktop/capabilities", workspaceId }).then(value => {
      if (live) setScope({ id: workspaceId, capabilities: (value ?? {}) as Record<string, string[]> })
    }).catch(reason => { if (live) setScope({ id: workspaceId, error: String(reason) }) })
    return () => { live = false }
  }, [bridge, workspaceId, revision])
  if (!workspaceId) return <p className="muted">{t("此專案尚未加入資料夾。")}</p>
  const ready = scope?.id === workspaceId ? scope : undefined
  return <>
    <label className="settings-scope-select">{t("成員資料夾")}
      <select value={workspaceId} onChange={event => setSelected(event.target.value)}>{members.map(row => <option key={row.id} value={row.id}>{row.label} · {row.path}</option>)}</select>
    </label>
    {ready?.error ? <p role="alert">{ready.error} <button type="button" onClick={() => setRevision(value => value + 1)}>{t("重試")}</button></p>
      : ready?.capabilities ? <ExtensionsSettings bridge={bridge} workspaceId={workspaceId} capabilities={ready.capabilities} tab={tab} onSelect={setTab}
        onUse={workspaceId === activeWorkspaceId ? onUse : undefined}
        onAuthoringRequest={ready.capabilities["desktop-resource-authoring"]?.includes("1") ? request => bridge.request(request) : undefined} />
      : <p role="status">{t("正在讀取資料夾功能…")}</p>}
  </>
}
