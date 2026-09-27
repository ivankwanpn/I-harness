import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { ReactNode } from "react"
import { FolderOpen, Plus, ChevronDown } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"

export interface WorkspaceSidebarProps {
  workspaces: WorkspaceEntry[]
  selectedId?: string
  onSelect(workspaceId: string): void
  onOpen(): void
  onCreate?(): void
  canCreate?: boolean
  children?: ReactNode
  onSettings?(): void
  onPlugins?(): void
}

export function WorkspaceSidebar({ workspaces, selectedId, onSelect, onOpen, onCreate, canCreate, children, onSettings, onPlugins }: WorkspaceSidebarProps) {
  const t = useText()
  return (
    <nav className="sidebar" aria-label={t("工作區")}>
      <div className="brand">I-harness <span>Desktop</span></div>
      <Button variant="ghost" className="sidebar-new" icon={<Plus size={17} />} disabled={!canCreate} onClick={onCreate}>{t("新增會話")}</Button>
      {onPlugins ? <Button variant="ghost" className="sidebar-open" onClick={onPlugins}>{t("插件市場")}</Button> : null}
      <h2 className="sidebar-title">{t("工作區")}</h2>
      <Button variant="ghost" className="sidebar-open" icon={<FolderOpen size={16} />} onClick={onOpen}>{t("開啟工作區")}</Button>
      {workspaces.length === 0 ? (
        <p className="notice">{t("尚未開啟工作區")}</p>
      ) : (
        <ul className="sidebar-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                className="row-button"
                aria-current={workspace.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(workspace.id)}
              >
                <span className="workspace-label" title={workspace.path}><ChevronDown size={14} /><span className="row-label">{workspace.label}</span></span>
              </button>
              {workspace.id === selectedId ? children : null}
            </li>
          ))}
        </ul>
      )}
      <div className="sidebar-footer">
        <Button variant="ghost" className="sidebar-open" onClick={onSettings}>{t("設定")}</Button>
      </div>
    </nav>
  )
}
