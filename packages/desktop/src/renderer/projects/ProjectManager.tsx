import { useEffect, useRef, useState } from "react"
import { Folder, FolderPlus, Pencil, Pin, Plus, ArrowLeft } from "lucide-react"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { useText } from "../design/i18n.ts"
import "./projects.css"

interface Draft { id?: string; name: string; workspaceIds: string[]; primaryWorkspaceId?: string; pinned: boolean; expectedUpdatedAt?: string }
export function ProjectManager({ bridge, projects, workspaces, onChanged, onOpen, onClose }: {
  bridge: DesktopBridge; projects: ProjectEntry[]; workspaces: WorkspaceEntry[]
  onChanged(): Promise<void>; onOpen(project: ProjectEntry): void; onClose(): void
}) {
  const t = useText()
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<Draft>()
  const [addedFolders, setAddedFolders] = useState<WorkspaceEntry[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState<ProjectEntry>()
  const locked = useRef(false)
  const folderMap = new Map([...workspaces, ...addedFolders].map((folder) => [folder.id, folder]))
  const trigger = useRef<HTMLElement | null>(null)
  const draftVersion = useRef(0)
  useEffect(() => () => { draftVersion.current++ }, [])
  const existing = draft?.id ? projects.find((project) => project.id === draft.id) : undefined
  const staleDraft = !!(draft?.expectedUpdatedAt && existing && existing.updatedAt !== draft.expectedUpdatedAt && !busy)
  function closeEditor() { draftVersion.current++; setDraft(undefined); setConfirmRemoval(undefined); setError(undefined); trigger.current?.focus() }
  function edit(project?: ProjectEntry) {
    trigger.current = document.activeElement as HTMLElement
    draftVersion.current++
    setError(undefined)
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
      if (version !== draftVersion.current) { await onChanged(); return }
      setAddedFolders((old) => [...old.filter((row) => row.id !== folder.id), folder])
      setDraft((old) => old ? { ...old, workspaceIds: [...new Set([...old.workspaceIds, folder.id])], primaryWorkspaceId: old.primaryWorkspaceId ?? folder.id } : old)
      await onChanged()
    })
  }
  return <section className="settings-pane project-manager" aria-label={t("專案")}>
    <header className="projects-header"><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label={t("返回會話")}><ArrowLeft size={18} /></button><h1>{t("專案")}</h1><input aria-label={t("搜尋專案")} placeholder={t("搜尋專案")} value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" disabled={busy} className="project-primary" onClick={() => edit()}><Plus size={15} />{t("新增專案")}</button></header>
    {error && !draft && !confirmRemoval ? <p role="alert" className="error-text">{error}</p> : null}
    <p className="project-description">{t("每個會話可存取專案內全部資料夾；主要資料夾作為新會話的預設起點。")}</p>
    <div className="projects-list">
      {projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase())).map((project) => <article className="project-list-row" key={project.id}>
        <button type="button" className="project-open" disabled={busy} onClick={() => onOpen(project)}><Folder size={18} /><span><strong>{project.name}</strong><small>{project.workspaceIds.length ? project.workspaceIds.map((id) => folderMap.get(id)?.label ?? id).join(" · ") : t("尚未加入資料夾")}</small></span></button>
        <time className="muted">{new Date(project.updatedAt).toLocaleDateString()}</time>
        <button type="button" className="icon-button" aria-label={t(project.pinned ? "取消釘選專案 {name}" : "釘選專案 {name}", { name: project.name })} aria-pressed={project.pinned === true} disabled={busy} onClick={() => { void action(async () => { await bridge.request({ kind: "projects/save", input: { ...project, expectedUpdatedAt: project.updatedAt, pinned: !project.pinned } }); await onChanged() }) }}><Pin size={15} /></button>
        <button type="button" className="icon-button" disabled={busy} aria-label={t("編輯專案 {name}", { name: project.name })} onClick={() => edit(project)}><Pencil size={15} /></button>
      </article>)}
      {projects.length === 0 ? <div className="project-empty"><FolderPlus size={28} /><p>{t("建立專案，集中管理資料夾與會話。")}</p></div> : null}
    </div>
    {draft ? <SettingsDialog title={t(draft.id ? "編輯專案" : "新增專案")} closeLabel={t("關閉")} busy={busy} initialFocusSelector="input[name='project-name']" onClose={closeEditor}>
      <form className="project-editor" onSubmit={(event) => { event.preventDefault(); if (staleDraft) return; void action(async () => { const saved = await bridge.request({ kind: "projects/save", input: draft }) as ProjectEntry & { runtimeSyncError?: string }; if (saved?.id) setDraft({ id: saved.id, name: saved.name ?? draft.name, workspaceIds: saved.workspaceIds ?? draft.workspaceIds, primaryWorkspaceId: saved.primaryWorkspaceId ?? draft.primaryWorkspaceId, pinned: saved.pinned ?? draft.pinned, expectedUpdatedAt: saved.updatedAt }); await onChanged(); if (saved.runtimeSyncError) throw new Error(saved.runtimeSyncError); closeEditor() }) }}>
        <label>{t("專案名稱")}<input name="project-name" maxLength={256} required value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <h3>{t("來源資料夾")}</h3>
        <div className="project-folder-list">{draft.workspaceIds.map((id) => { const folder = folderMap.get(id); return <div key={id} className="project-folder-row"><Folder size={15} /><span title={folder?.path}>{folder?.label ?? id}<small>{folder?.path}</small></span><button type="button" className="project-badge" aria-label={t("設為主要資料夾 {name}", { name: folder?.label ?? id })} aria-pressed={draft.primaryWorkspaceId === id} disabled={busy} onClick={() => setDraft({ ...draft, primaryWorkspaceId: id })}>{t(draft.primaryWorkspaceId === id ? "主要" : "設為主要")}</button><button type="button" className="icon-button" disabled={busy} aria-label={t("移除資料夾 {name}", { name: folder?.label ?? id })} onClick={() => setDraft({ ...draft, workspaceIds: draft.workspaceIds.filter((candidate) => candidate !== id), primaryWorkspaceId: draft.primaryWorkspaceId === id ? draft.workspaceIds.find((candidate) => candidate !== id) : draft.primaryWorkspaceId })}>×</button></div> })}
          <button type="button" className="project-add-folder" disabled={busy} onClick={() => { void pickFolder() }}><FolderPlus size={16} />{t("新增資料夾")}</button>
        </div>
        {workspaces.some((folder) => !draft.workspaceIds.includes(folder.id)) ? <label>{t("加入已開啟的資料夾")}<select disabled={busy} value="" onChange={(event) => { const id = event.target.value; if (id) setDraft({ ...draft, workspaceIds: [...draft.workspaceIds, id], primaryWorkspaceId: draft.primaryWorkspaceId ?? id }) }}><option value="">{t("選擇資料夾")}</option>{workspaces.filter((folder) => !draft.workspaceIds.includes(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.label} · {folder.path}</option>)}</select></label> : null}
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        {staleDraft ? <p role="alert" className="error-text">{t("專案已更新，請重新開啟編輯以保留最新資料夾設定。")}</p> : null}
        <footer className="project-editor-footer">{draft.id ? <button type="button" className="project-danger" disabled={busy} onClick={() => { const project = projects.find((row) => row.id === draft.id); if (project) { setDraft(undefined); setConfirmRemoval(project) } }}>{t("移除本機專案")}</button> : <span />}<button type="button" className="project-secondary" disabled={busy} onClick={closeEditor}>{t("取消")}</button><button type="submit" className="project-primary" disabled={busy || staleDraft || !draft.name.trim()}>{t(busy ? "儲存中…" : "儲存")}</button></footer>
      </form>
    </SettingsDialog> : null}
    {confirmRemoval ? <SettingsDialog title={t("移除本機專案")} closeLabel={t("關閉")} busy={busy} initialFocusSelector="button.project-secondary" onClose={closeEditor}><p>{t("僅移除專案分組，資料夾和會話會保留。")}</p><p>{confirmRemoval.name}</p>{error ? <p role="alert" className="error-text">{error}</p> : null}<footer className="project-editor-footer"><button type="button" className="project-secondary" disabled={busy} onClick={closeEditor}>{t("取消")}</button><button type="button" className="project-danger" disabled={busy} onClick={() => { void action(async () => { const result = await bridge.request({ kind: "projects/remove", id: confirmRemoval.id }) as { runtimeSyncError?: string }; closeEditor(); await onChanged(); if (result?.runtimeSyncError) throw new Error(result.runtimeSyncError) }) }}>{t("確認移除專案")}</button></footer></SettingsDialog> : null}
  </section>
}
