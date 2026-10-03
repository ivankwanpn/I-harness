import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { ProjectFileRef, ProjectFileRoot, ProjectFileSelection, ProjectFilesRequester } from "../../../../desktop-gateway/src/project-files.ts"
import { ProjectExplorer } from "./ProjectExplorer.tsx"
import { EditorTabs } from "./EditorTabs.tsx"
import { SourceFileEditor, type EditableSource, type ReviewSaveResult } from "./SourceFileEditor.tsx"
import { EditorDraftStore, editorDraftKey, getEditorDraftStore } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"

export interface ProjectFilesPaneProps {
  selection: ProjectFileSelection
  request: ProjectFilesRequester
  /** Keep this prop in caller state. Each navigation click supplies a new ref
   * object so selecting the same file reopens a previously closed tab. */
  openFile?: ProjectFileRef
  store?: EditorDraftStore
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export function ProjectFilesPane({ selection, request, openFile, store = getEditorDraftStore() }: ProjectFilesPaneProps) {
  const pf = useProjectFilesText()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [rootState, setRootState] = useState<{ selectionKey: string; roots: ProjectFileRoot[] }>(), [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0)
  const [loaded, setLoaded] = useState<{ identity: string; value: EditableSource }>()
  const selectionKey = JSON.stringify(selection), current = useRef(selectionKey)
  current.current = selectionKey
  const roots = rootState?.selectionKey === selectionKey ? rootState.roots : []
  const active = state.active, activeKey = active ? editorDraftKey(active) : "", loadIdentity = `${selectionKey}:${activeKey}:${refresh}`
  const member = !!active && roots.some((root) => root.workspaceId === active.workspaceId)
  useEffect(() => {
    let valid = true
    setError(undefined)
    request({ ...selection, kind: "desktop/project-files/roots" }).then((value) => {
      const result = value as { roots: ProjectFileRoot[] }
      if (!result || !Array.isArray(result.roots) || !result.roots.every((root) => typeof root.workspaceId === "string" && typeof root.label === "string")) throw new Error("Invalid project roots")
      if (valid) setRootState({ selectionKey, roots: result.roots })
    }).catch((error) => { if (valid) { setRootState({ selectionKey, roots: [] }); setError(errorText(error)) } })
    return () => { valid = false }
  }, [selectionKey, request, refresh])
  useEffect(() => { if (openFile) store.open(openFile) }, [store, openFile])
  useEffect(() => {
    if (!active || !member) return
    let valid = true
    request({ ...selection, kind: "desktop/project-files/read", ref: active }).then((value) => { if (valid) setLoaded({ identity: loadIdentity, value: value as EditableSource }) }).catch((error) => { if (valid) { setLoaded({ identity: loadIdentity, value: { kind: "unavailable", reason: errorText(error) } }); store.feedback(active, errorText(error)) } })
    return () => { valid = false }
  }, [loadIdentity, member, request, store])
  async function save(ref: ProjectFileRef, text: string, expectedRevision: string): Promise<ReviewSaveResult> {
    if (current.current !== selectionKey || !roots.some((root) => root.workspaceId === ref.workspaceId)) return { kind: "unavailable", reason: "withdrawn-root" }
    return await request({ ...selection, kind: "desktop/project-files/save", ref, text, expectedRevision }) as ReviewSaveResult
  }
  async function saveTab(ref: ProjectFileRef) {
    if (!roots.some((root) => root.workspaceId === ref.workspaceId) || store.get(ref)?.external) return false
    try {
      const value = await request({ ...selection, kind: "desktop/project-files/read", ref }) as EditableSource
      if (current.current !== selectionKey || value.kind !== "text" || value.truncated || !value.revision) return false
      store.ingest(ref, value)
      if (store.get(ref)?.external) return false
      return (await store.save(ref, (text, revision) => save(ref, text, revision))).kind === "saved"
    } catch (error) { store.feedback(ref, errorText(error)); return false }
  }
  return <section className="project-files-pane" aria-label={pf("專案檔案與編輯")}>
    <div className="review-head"><h3 className="review-title">{pf("專案檔案")}</h3><button type="button" className="link-button" onClick={() => setRefresh((value) => value + 1)}>{pf("重新整理專案檔案")}</button></div>
    {error ? <p role="alert" className="notice error-text">{error}</p> : null}
    <ProjectExplorer key={`explorer:${selectionKey}`} roots={roots} selection={selection} request={request} onOpen={(ref) => store.open(ref)} refresh={refresh} />
    <EditorTabs key={`tabs:${selectionKey}`} roots={roots} store={store} onSave={saveTab} />
    {active ? <><p className="row-label">{roots.find((root) => root.workspaceId === active.workspaceId)?.label ?? active.workspaceId}/{active.path}</p>
      <SourceFileEditor workspaceId={active.workspaceId} path={active.path} store={store} available={member} value={loaded?.identity === loadIdentity ? loaded.value : undefined}
        onSave={(_path, text, revision) => save(active, text, revision)} onReload={() => setRefresh((value) => value + 1)} /></> : <p className="muted">{pf("從檔案樹或搜尋開啟檔案。")}</p>}
    {state.persistenceError ? <p role="alert">{state.persistenceError}</p> : null}
  </section>
}
