import { useMemo, useRef, useState, type ReactNode } from "react"
import { ExternalLink, Folder, FolderPlus, GitBranch, Pencil, Pin } from "lucide-react"
import type { ProjectEntry } from "../../main/projects.ts"
import { isProjectColor, projectColors } from "../../shared/project-colors.ts"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { ProjectManager, type ProjectCatalogProps } from "./ProjectManager.tsx"

type ProjectPage = "general" | "workspaces" | "extensions"
export interface ProjectSettingsSelection {
  id: string
  page: ProjectPage
}
const colorLabels = { default: "主題預設", blue: "藍色", green: "綠色", amber: "琥珀色", violet: "紫色", rose: "玫瑰色" } as const

export function ProjectSettings({ renderExtensions, onOpen, navigation, ...catalog }: ProjectCatalogProps & {
  renderExtensions(project: ProjectEntry): ReactNode
  onOpen?(project: ProjectEntry): void
  navigation: { selection?: ProjectSettingsSelection; onNavigate(next: ProjectSettingsSelection): void }
}) {
  const t = useText()
  const { selection, onNavigate } = navigation
  const project = catalog.projects.find(row => row.id === selection?.id)
  return <ProjectManager {...catalog} onOpen={row => onNavigate({ id: row.id, page: "general" })} renderDetail={project && selection ? ({ busy, edit, remove, updateAppearance }) => <>
    {selection.page === "general" && onOpen && project.workspaceIds.length > 0 ? <div className="project-open-actions">
      <Button size="small" disabled={busy} onClick={() => onOpen(project)}>{t("開啟專案")}</Button>
    </div> : null}
    {selection.page === "general" ? <SettingsGroup>
      <SettingsRow label={t("專案名稱")} description={project.name} control={<Button size="small" icon={<Pencil size={14} />} disabled={busy} onClick={() => edit(project)}>{t("編輯專案")}</Button>} />
      <SettingsRow label={t("專案顏色")} control={<select aria-label={t("專案顏色")} value={project.color ?? "default"} disabled={busy} onChange={event => {
        const color = event.target.value
        if (isProjectColor(color)) updateAppearance(project, { color })
      }}>{projectColors.map(color => <option key={color} value={color}>{t(colorLabels[color])}</option>)}</select>} />
      <SettingsRow label={t("在側邊欄釘選")} control={<Button size="small" icon={<Pin size={14} />} disabled={busy} aria-pressed={project.pinned === true} onClick={() => updateAppearance(project, { pinned: !project.pinned })}>{t(project.pinned ? "取消釘選" : "釘選")}</Button>} />
      <SettingsRow label={t("移除本機專案")} description={t("僅移除專案分組，資料夾和會話會保留。")}
        control={<Button size="small" variant="danger" disabled={busy} onClick={() => remove(project)}>{t("移除本機專案")}</Button>} />
    </SettingsGroup> : selection.page === "workspaces" ? <WorkspaceSettings {...catalog} project={project} onEdit={() => edit(project, true)} />
      : renderExtensions(project)}
  </> : undefined} />
}

export function WorkspaceSettings({ bridge, projects, workspaces, onChanged, project, onEdit }: ProjectCatalogProps & {
  project?: ProjectEntry
  onEdit?(): void
}) {
  const t = useText()
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const inventory = useMemo(() => {
    const scope = project ? [project] : projects
    const projectById = new Map(scope.map(owner => [owner.id, owner]))
    const folderOwners = new Map<string, ProjectEntry[]>()
    for (const owner of scope) for (const id of owner.workspaceIds) {
      const owners = folderOwners.get(id)
      if (owners) owners.push(owner)
      else folderOwners.set(id, [owner])
    }
    return workspaces.flatMap(workspace => {
      const binding = workspace.worktree
      const worktreeOwner = binding && projectById.get(binding.projectId)
      const owners = binding ? (worktreeOwner ? [worktreeOwner] : []) : folderOwners.get(workspace.id) ?? []
      if (project && !owners.length) return []
      const details: string[] = []
      const offerSupported = !!(binding && worktreeOwner?.workspaceIds.includes(binding.sourceWorkspaceId))
      if (binding) {
        details.push(t(binding.kind === "managed" ? "IH 建立的 Git 工作樹" : "匯入的 Git 工作樹"))
        if (!project && worktreeOwner) details.push(worktreeOwner.name)
        details.push(offerSupported ? t(binding.offered === false ? "已停止供新會話選用" : "可供新會話選用") : t("來源資料夾已離開專案"))
      } else {
        for (const owner of owners) {
          const role = t((owner.primaryWorkspaceId ?? owner.workspaceIds[0]) === workspace.id ? "主要資料夾" : "成員資料夾")
          details.push(project ? role : `${owner.name} · ${role}`)
        }
      }
      if (!owners.length) details.push(t("未加入專案"))
      return [{ workspace, owners, details, binding, offerSupported }]
    })
  }, [project, projects, workspaces, t])
  const needle = query.trim().toLocaleLowerCase()
  const visible = inventory.filter(({ workspace, owners }) =>
    [workspace.label, workspace.path, ...owners.map(owner => owner.name)].some(value => value.toLocaleLowerCase().includes(needle)))
  async function act(work: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(undefined)
    try { await work() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { locked.current = false; setBusy(false) }
  }
  return <section className="settings-workspace-inventory" aria-label={t("工作區")}>
    <div className="settings-catalog-toolbar">
      {inventory.length > 0 ? <div className="settings-catalog-search"><SearchInput aria-label={t("搜尋工作區")} placeholder={t("搜尋工作區")} clearLabel={t("清除搜尋")} value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")} /></div> : <span />}
      {onEdit ? <Button size="small" icon={<FolderPlus size={15} />} disabled={busy} onClick={onEdit}>{t("管理資料夾")}</Button> : !project ? <Button size="small" icon={<FolderPlus size={15} />} disabled={busy} onClick={() => void act(async () => {
        const picked = await bridge.request({ kind: "workspace/pick" })
        if (picked) await onChanged()
      })}>{t("登記資料夾")}</Button> : null}
    </div>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {visible.length ? <ul className="workspace-inventory-list">
      {visible.map(({ workspace, binding, details, offerSupported }) => <li key={workspace.id} className="workspace-inventory-row">
          <span className="project-list-icon">{binding ? <GitBranch size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}</span>
          <div className="workspace-inventory-description">
            <strong>{workspace.label}</strong>
            <small className="workspace-inventory-path" title={workspace.path}>{workspace.path}</small>
            <small className="workspace-inventory-membership">{details.join(" · ")}</small>
          </div>
          <div className="workspace-inventory-actions">
            {binding && offerSupported ? <Button size="small" disabled={busy} title={t("停止選用會保留原有會話、分支與檔案。")} onClick={() => void act(async () => {
              await bridge.request({ kind: "desktop/worktrees/offer", workspaceId: workspace.id, projectId: binding.projectId, offered: binding.offered === false })
              await onChanged()
            })}>{t(binding.offered === false ? "恢復選用" : "停止選用")}</Button> : null}
            <Button size="small" variant="ghost" disabled={busy} icon={<ExternalLink size={14} />} aria-label={`${t("開啟工作區資料夾")} · ${workspace.label}`} title={t("開啟工作區資料夾")} onClick={() => void act(async () => {
              await bridge.request({ kind: "workspace/reveal", workspaceId: workspace.id })
            })} />
          </div>
        </li>)}
    </ul> : <p className="ih-empty-state">{t(inventory.length ? "沒有符合的工作區" : "尚無工作區")}</p>}
  </section>
}
