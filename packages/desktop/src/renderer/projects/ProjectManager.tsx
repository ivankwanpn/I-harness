import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRight, Folder, FolderPlus, Plus } from "lucide-react"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import "./projects.css"

interface Draft { id?: string; name: string; workspaceIds: string[]; primaryWorkspaceId?: string; pinned: boolean; expectedUpdatedAt?: string }
export interface ProjectCatalogProps {
  bridge: DesktopBridge; projects: ProjectEntry[]; workspaces: WorkspaceEntry[]
  onChanged(): Promise<void>
}
interface ProjectDetailActions {
  busy: boolean
  edit(project: ProjectEntry, foldersOnly?: boolean): void
  remove(project: ProjectEntry): void
  updateAppearance(project: ProjectEntry, changes: Pick<ProjectEntry, "pinned" | "color">): void
}
export function ProjectManager({ bridge, projects, workspaces, onChanged, onOpen, renderDetail }: ProjectCatalogProps & {
  onOpen(project: ProjectEntry): void
  renderDetail?(actions: ProjectDetailActions): ReactNode
}) {
  const t = useText()
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<Draft>()
  const [foldersOnly, setFoldersOnly] = useState(false)
  const [addedFolders, setAddedFolders] = useState<WorkspaceEntry[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState<ProjectEntry>()
  const locked = useRef(false)
  const folderMap = new Map([...workspaces, ...addedFolders].map((folder) => [folder.id, folder]))
  const trigger = useRef<HTMLElement | null>(null)
  const restoreListFocus = useRef<string | undefined>(undefined)
  const draftVersion = useRef(0)
  useEffect(() => () => { draftVersion.current++ }, [])
  const existing = draft?.id ? projects.find((project) => project.id === draft.id) : undefined
  const staleDraft = !!(draft?.expectedUpdatedAt && existing && existing.updatedAt !== draft.expectedUpdatedAt && !busy)
  const needle = query.trim().toLowerCase()
  const filteredProjects = projects.filter(project => project.name.toLowerCase().includes(needle)
    || project.workspaceIds.some(id => folderMap.get(id)?.path.toLowerCase().includes(needle)))
  function closeEditor() { draftVersion.current++; setDraft(undefined); setConfirmRemoval(undefined); setError(undefined); trigger.current?.focus() }
  function edit(project?: ProjectEntry, editFoldersOnly = false) {
    trigger.current = document.activeElement as HTMLElement
    draftVersion.current++
    setError(undefined)
    setFoldersOnly(editFoldersOnly)
    setDraft(project ? { id: project.id, name: project.name, workspaceIds: [...project.workspaceIds], primaryWorkspaceId: project.primaryWorkspaceId, pinned: project.pinned ?? false, expectedUpdatedAt: project.updatedAt } : { name: "", workspaceIds: [], pinned: false })
  }
  async function action(work: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(undefined)
    try { await work() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { locked.current = false; setBusy(false) }
  }
  async function pickFolder() {
    const version = draftVersion.current
    await action(async () => {
      const folder = await bridge.request({ kind: "workspace/pick" }) as WorkspaceEntry | undefined
      if (!folder) return
      if (folder.worktree) throw new Error(folder.path + " already has a conversation worktree binding")
      if (version !== draftVersion.current) { await onChanged(); return }
      setAddedFolders((old) => [...old.filter((row) => row.id !== folder.id), folder])
      setDraft((old) => old ? { ...old, workspaceIds: [...new Set([...old.workspaceIds, folder.id])], primaryWorkspaceId: old.primaryWorkspaceId ?? folder.id } : old)
      await onChanged()
    })
  }
  function updateAppearance(project: ProjectEntry, changes: Pick<ProjectEntry, "pinned" | "color">) {
    void action(async () => {
      await bridge.request({ kind: "projects/appearance", id: project.id, expectedUpdatedAt: project.updatedAt, ...changes })
      await onChanged()
    })
  }
  function remove(project: ProjectEntry) {
    trigger.current = document.activeElement as HTMLElement
    setError(undefined)
    setConfirmRemoval(project)
  }
  const search = projects.length ? <SearchInput aria-label={t("搜尋專案")} placeholder={t("搜尋專案")} value={query} clearLabel={t("清除搜尋")} onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")} /> : null
  return <section className="settings-project-catalog ih-control-scope" aria-label={t("專案")}>
    {error && !draft && !confirmRemoval ? <p role="alert" className="error-text">{error}</p> : null}
    {renderDetail ? renderDetail({ busy, edit, remove, updateAppearance }) : <>
    <header className="settings-catalog-toolbar">
      <div className="settings-catalog-search">{search}</div>
      <Button variant="primary" icon={<Plus size={15} />} disabled={busy} onClick={() => edit()}>{t("新增專案")}</Button>
    </header>
    <div className="projects-list">
      {filteredProjects.map((project) => <article className="project-list-row" key={project.id}>
        <button type="button" className="project-open" disabled={busy} ref={button => {
          if (button && restoreListFocus.current === project.id) { restoreListFocus.current = undefined; button.focus() }
        }} onClick={() => { restoreListFocus.current = project.id; onOpen(project) }}>
          <span className="project-list-icon" data-project-color={project.color}><Folder size={18} aria-hidden="true" /></span>
          <span className="project-list-name"><strong>{project.name}</strong><small>{project.workspaceIds.length ? project.workspaceIds.map((id) => folderMap.get(id)?.label ?? id).join(" · ") : t("尚未加入資料夾")}</small></span>
          <ChevronRight size={15} aria-hidden="true" className="project-list-chevron" />
        </button>
      </article>)}
      {projects.length === 0 ? <div className="project-empty ih-empty-state"><FolderPlus size={22} aria-hidden="true" /><p>{t("建立專案，集中管理資料夾與會話。")}</p></div> : null}
      {projects.length > 0 && filteredProjects.length === 0 ? <p className="ih-empty-state">{t("沒有符合的專案")}</p> : null}
    </div>
    </>}
    {draft ? <SettingsDialog title={t(foldersOnly ? "管理資料夾" : draft.id ? "編輯專案" : "新增專案")} closeLabel={t("關閉")} busy={busy} initialFocusSelector={foldersOnly ? ".project-add-folder" : "input[name='project-name']"} onClose={closeEditor}>
      <form className="project-editor" onSubmit={(event) => { event.preventDefault(); if (staleDraft) return; void action(async () => { const saved = await bridge.request({ kind: "projects/save", input: draft }) as ProjectEntry & { runtimeSyncError?: string }; if (saved?.id) setDraft({ id: saved.id, name: saved.name ?? draft.name, workspaceIds: saved.workspaceIds ?? draft.workspaceIds, primaryWorkspaceId: saved.primaryWorkspaceId ?? draft.primaryWorkspaceId, pinned: saved.pinned ?? draft.pinned, expectedUpdatedAt: saved.updatedAt }); await onChanged(); if (saved.runtimeSyncError) throw new Error(saved.runtimeSyncError); closeEditor() }) }}>
        {foldersOnly ? null : <label>{t("專案名稱")}<input name="project-name" maxLength={256} required value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>}
        <h3>{t("來源資料夾")}</h3>
        {draft.id ? <p className="muted project-membership-note">{t("移除資料夾會取消此專案對它的存取。資料夾和既有會話會保留。")}</p> : null}
        <div className="project-folder-list">{draft.workspaceIds.map((id) => { const folder = folderMap.get(id); return <div key={id} className="project-folder-row"><Folder size={15} /><span title={folder?.path}>{folder?.label ?? id}<small>{folder?.path}</small></span><button type="button" className="project-badge" aria-label={t("設為主要資料夾 {name}", { name: folder?.label ?? id })} aria-pressed={draft.primaryWorkspaceId === id} disabled={busy} onClick={() => setDraft({ ...draft, primaryWorkspaceId: id })}>{t(draft.primaryWorkspaceId === id ? "主要" : "設為主要")}</button><button type="button" className="icon-button" disabled={busy} aria-label={t("移除資料夾 {name}", { name: folder?.label ?? id })} onClick={() => setDraft({ ...draft, workspaceIds: draft.workspaceIds.filter((candidate) => candidate !== id), primaryWorkspaceId: draft.primaryWorkspaceId === id ? draft.workspaceIds.find((candidate) => candidate !== id) : draft.primaryWorkspaceId })}>×</button></div> })}
          <button type="button" className="project-add-folder" disabled={busy} onClick={() => { void pickFolder() }}><FolderPlus size={16} />{t("新增資料夾")}</button>
        </div>
        {workspaces.some((folder) => !folder.worktree && !draft.workspaceIds.includes(folder.id)) ? <label>{t("加入已開啟的資料夾")}<select disabled={busy} value="" onChange={(event) => { const id = event.target.value; if (id) setDraft({ ...draft, workspaceIds: [...draft.workspaceIds, id], primaryWorkspaceId: draft.primaryWorkspaceId ?? id }) }}><option value="">{t("選擇資料夾")}</option>{workspaces.filter((folder) => !folder.worktree && !draft.workspaceIds.includes(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.label} · {folder.path}</option>)}</select></label> : null}
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        {staleDraft ? <p role="alert" className="error-text">{t("專案已更新，請重新開啟編輯以保留最新資料夾設定。")}</p> : null}
        <footer className="settings-dialog-actions">
          <Button disabled={busy} onClick={closeEditor}>{t("取消")}</Button>
          <Button type="submit" variant="primary" disabled={staleDraft || !draft.name.trim()} loading={busy} loadingLabel={t("儲存中…")}>{t("儲存")}</Button>
        </footer>
      </form>
    </SettingsDialog> : null}
    {confirmRemoval ? <SettingsDialog title={t("移除本機專案")} closeLabel={t("關閉")} busy={busy} initialFocusSelector="[data-dialog-cancel]" onClose={closeEditor}>
      <p>{t("僅移除專案分組，資料夾和會話會保留。")}</p><p><strong>{confirmRemoval.name}</strong></p>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      <footer className="settings-dialog-actions">
        <Button data-dialog-cancel disabled={busy} onClick={closeEditor}>{t("取消")}</Button>
        <Button variant="danger" loading={busy} onClick={() => { void action(async () => { const result = await bridge.request({ kind: "projects/remove", id: confirmRemoval.id }) as { runtimeSyncError?: string }; closeEditor(); await onChanged(); if (result?.runtimeSyncError) throw new Error(result.runtimeSyncError) }) }}>{t("確認移除專案")}</Button>
      </footer>
    </SettingsDialog> : null}
  </section>
}
