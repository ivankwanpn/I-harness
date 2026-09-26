import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { ReactNode } from "react"
import { FolderOpen, Plus, ChevronDown } from "lucide-react"
import { useText } from "../design/i18n.ts"

export interface WorkspaceSidebarProps {
  workspaces: WorkspaceEntry[]
  selectedId?: string
  onSelect(workspaceId: string): void
  onOpen(): void
  onCreate?(): void
  canCreate?: boolean
  children?: ReactNode
  onSettings?(): void
}

export function WorkspaceSidebar({ workspaces, selectedId, onSelect, onOpen, onCreate, canCreate, children, onSettings }: WorkspaceSidebarProps) {
  const t = useText()
  return (
    <nav className="sidebar" aria-label={t("工作區")}>
      <div className="brand">I-harness <span>Desktop</span></div>
      <button type="button" className="sidebar-new" disabled={!canCreate} onClick={onCreate}><Plus size={18} />{t("新增會話")}</button>
      <h2 className="sidebar-title">{t("工作區")}</h2>
      <button type="button" className="primary-button sidebar-open" onClick={onOpen}>
        <FolderOpen size={16} />{t("開啟工作區")}
      </button>
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
        <button type="button" className="row-button" onClick={onSettings}>{t("設定")}</button>
      </div>
    </nav>
  )
}
