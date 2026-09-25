import type { WorkspaceEntry } from "../../main/workspaces.ts"

export interface WorkspaceSidebarProps {
  workspaces: WorkspaceEntry[]
  selectedId?: string
  onSelect(workspaceId: string): void
}

export function WorkspaceSidebar({ workspaces, selectedId, onSelect }: WorkspaceSidebarProps) {
  return (
    <nav className="sidebar" aria-label="工作區">
      <h2 className="sidebar-title">工作區</h2>
      {workspaces.length === 0 ? (
        <p className="notice">尚未開啟工作區</p>
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
                <span className="row-label">{workspace.label}</span>
                <span className="row-path" title={workspace.path}>{workspace.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
