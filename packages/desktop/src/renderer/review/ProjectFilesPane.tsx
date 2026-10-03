import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { ProjectFileRef, ProjectFileRoot, ProjectFileSelection, ProjectFilesRequester } from "../../../../desktop-gateway/src/project-files.ts"
import { ProjectExplorer } from "./ProjectExplorer.tsx"
import { EditorTabs } from "./EditorTabs.tsx"
import { SourceFileEditor, type EditableSource, type ReviewSaveResult } from "./SourceFileEditor.tsx"
import { EditorDraftStore, editorDraftKey, getEditorDraftStore, isDraftDirty } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"
import { absoluteReferencePath, type ExternalFileTarget, type FileOpenTarget, type ProjectFileTarget } from "../session/file-navigation.ts"
import { checkedEditableSource, checkedFileRef, checkedProjectRoots, checkedSaveResult, revisionString } from "./project-file-responses.ts"
import { checkedSearchCancel, checkedSearchPreview, utf8Encoding, type SearchPreview } from "./content-search-results.ts"
import { ExternalFileViewer } from "./ExternalFileViewer.tsx"

export interface ProjectFilesPaneProps {
  selection: ProjectFileSelection
  request: ProjectFilesRequester
  /** Keep this prop in caller state. Each navigation click supplies a new ref
   * object so selecting the same file reopens a previously closed tab. */
  openFile?: ProjectFileTarget
  externalOpenFile?: ExternalFileTarget
  contentSearchAvailable?: boolean
  /** Presentation freshness only. Native current membership remains authority. */
  membershipRevision?: string
  store?: EditorDraftStore
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export function ProjectFilesPane({ selection, request, openFile, externalOpenFile, contentSearchAvailable = false, membershipRevision = "", store = getEditorDraftStore() }: ProjectFilesPaneProps) {
  const pf = useProjectFilesText()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [rootState, setRootState] = useState<{ scopeKey: string; roots: ProjectFileRoot[] }>(), [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0)
  const [loaded, setLoaded] = useState<{ identity: string; value: EditableSource }>()
  const [preview, setPreview] = useState<{ identity: string; value: SearchPreview }>(), [target, setTarget] = useState<{ selectionKey: string; ref: ProjectFileRef; navigation: ProjectFileTarget["navigation"] }>()
  const [external, setExternal] = useState<{ selectionKey: string; target: ExternalFileTarget }>()
  const selectionKey = JSON.stringify(selection), rootScopeKey = JSON.stringify([selectionKey, membershipRevision]), current = useRef(rootScopeKey)
  current.current = rootScopeKey
  const roots = rootState?.scopeKey === rootScopeKey ? rootState.roots : []
  const active = state.active, activeKey = active ? editorDraftKey(active) : ""
  const navigation = target?.selectionKey === selectionKey && target && editorDraftKey(target.ref) === activeKey ? target.navigation : undefined
  const loadIdentity = `${rootScopeKey}:${activeKey}:${refresh}:${navigation?.nonce ?? ""}`
  const member = !!active && roots.some((root) => root.workspaceId === active.workspaceId)
  useEffect(() => {
    let valid = true
    setRootState(undefined); setError(undefined)
    request({ ...selection, kind: "desktop/project-files/roots" }).then((value) => {
      const roots = checkedProjectRoots(value)
      if (valid) setRootState({ scopeKey: rootScopeKey, roots })
    }).catch((error) => { if (valid) { setRootState({ scopeKey: rootScopeKey, roots: [] }); setError(errorText(error)) } })
    return () => { valid = false }
  }, [rootScopeKey, request, refresh])
  function open(target: FileOpenTarget) {
    try {
      if ("reference" in target) {
        if (target.reference.readonly !== true || !absoluteReferencePath(target.reference.path)) throw new Error("Invalid readonly reference file")
        setExternal({ selectionKey, target })
        return
      }
      const ref = checkedFileRef(target)
      store.open(ref)
      setExternal(undefined)
      setTarget({ selectionKey, ref, navigation: target.navigation })
    } catch (reason) { setError(errorText(reason)) }
  }
  useEffect(() => { if (openFile) open(openFile) }, [store, openFile, selectionKey])
  useEffect(() => { setExternal(undefined) }, [selectionKey])
  useEffect(() => { if (externalOpenFile) open(externalOpenFile) }, [externalOpenFile])
  useEffect(() => {
    if (!active || !member) return
    let valid = true
    const originalSelection = { ...selection }
    let ownedPreview: { requestId: string; pending: boolean; cancelled: boolean } | undefined
    function cancelPreview() {
      if (!ownedPreview?.pending || ownedPreview.cancelled) return
      ownedPreview.cancelled = true
      try { void request({ ...originalSelection, kind: "desktop/project-files/content-cancel", requestId: ownedPreview.requestId }).then(checkedSearchCancel).catch(() => {}) }
      catch { /* Native shutdown also drains captured jobs if the bridge is gone. */ }
    }
    const ref = { workspaceId: active.workspaceId, path: active.path }
    void (async () => {
      try {
        const dirty = isDraftDirty(store.get(ref))
        const previewOnly = navigation && (!utf8Encoding(navigation.encoding) || navigation.readonly || navigation.external) && !dirty
        const value = previewOnly ? { kind: "unavailable" as const, reason: "search-preview" } : checkedEditableSource(await request({ ...selection, kind: "desktop/project-files/read", ref }))
        if (!valid) return
        if (navigation && !isDraftDirty(store.get(ref)) && (previewOnly || value.kind !== "text" || value.truncated || value.readonly || value.external || !revisionString(value.revision))) {
          ownedPreview = { requestId: crypto.randomUUID(), pending: true, cancelled: false }
          const snapshot = checkedSearchPreview(await request({ ...originalSelection, kind: "desktop/project-files/search-preview", ref, requestId: ownedPreview.requestId, line: navigation.line, encoding: navigation.encoding ?? "auto", ...(navigation.revision ? { expectedRevision: navigation.revision } : {}) }))
          ownedPreview.pending = false
          if (valid) setPreview({ identity: loadIdentity, value: snapshot })
        }
        if (valid) setLoaded({ identity: loadIdentity, value })
      } catch (error) { cancelPreview(); if (valid) { setLoaded({ identity: loadIdentity, value: { kind: "unavailable", reason: errorText(error) } }); store.feedback(ref, errorText(error)) } }
      finally { if (ownedPreview) ownedPreview.pending = false }
    })()
    return () => { valid = false; cancelPreview() }
  }, [loadIdentity, member, request, store])
  async function save(ref: ProjectFileRef, text: string, expectedRevision: string): Promise<ReviewSaveResult> {
    if (current.current !== rootScopeKey || !roots.some((root) => root.workspaceId === ref.workspaceId)) return { kind: "unavailable", reason: "withdrawn-root" }
    return checkedSaveResult(await request({ ...selection, kind: "desktop/project-files/save", ref, text, expectedRevision }))
  }
  async function saveTab(ref: ProjectFileRef) {
    if (!roots.some((root) => root.workspaceId === ref.workspaceId) || store.get(ref)?.external) return false
    try {
      const value = checkedEditableSource(await request({ ...selection, kind: "desktop/project-files/read", ref }))
      if (current.current !== rootScopeKey || value.kind !== "text" || value.truncated || value.readonly || value.external || !value.revision) return false
      store.ingest(ref, value)
      if (store.get(ref)?.external) return false
      return (await store.save(ref, (text, revision) => save(ref, text, revision))).kind === "saved"
    } catch (error) { store.feedback(ref, errorText(error)); return false }
  }
  return <section className="project-files-pane" aria-label={pf("專案檔案與編輯")}>
    <div className="review-head"><h3 className="review-title">{pf("專案檔案")}</h3><button type="button" className="link-button" onClick={() => setRefresh((value) => value + 1)}>{pf("重新整理專案檔案")}</button></div>
    {error ? <p role="alert" className="notice error-text">{error}</p> : null}
    <ProjectExplorer key={`explorer:${selectionKey}`} roots={roots} selection={selection} request={request} onOpen={open} refresh={refresh} contentSearchAvailable={contentSearchAvailable} />
    <EditorTabs key={`tabs:${selectionKey}`} roots={roots} store={store} onSave={saveTab} onOpen={open} />
    {external?.selectionKey === selectionKey ? <ExternalFileViewer target={external.target} selection={selection} request={request} onClose={() => setExternal(undefined)} /> : active ? <><p className="row-label">{roots.find((root) => root.workspaceId === active.workspaceId)?.label ?? active.workspaceId}/{active.path}</p>
      <SourceFileEditor workspaceId={active.workspaceId} path={active.path} store={store} available={member} value={loaded?.identity === loadIdentity ? loaded.value : undefined}
        navigation={navigation} preview={member && preview?.identity === loadIdentity ? preview.value : undefined}
        onSave={(_path, text, revision) => save(active, text, revision)} onReload={() => setRefresh((value) => value + 1)} /></> : <p className="muted">{pf("從檔案樹或搜尋開啟檔案。")}</p>}
    {state.persistenceError ? <p role="alert">{state.persistenceError}</p> : null}
  </section>
}
