import { useState, useSyncExternalStore } from "react"
import type { ProjectFileRef, ProjectFileRoot } from "../../../../desktop-gateway/src/project-files.ts"
import { EditorDraftStore, editorDraftKey, isDraftDirty } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"

export function EditorTabs({ roots, store, onSave }: { roots: ProjectFileRoot[]; store: EditorDraftStore; onSave(ref: ProjectFileRef): Promise<boolean> }) {
  const pf = useProjectFilesText()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [closing, setClosing] = useState<ProjectFileRef>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const label = (ref: ProjectFileRef) => `${roots.find((root) => root.workspaceId === ref.workspaceId)?.label ?? `${ref.workspaceId}（${pf("已移出")}）`}/${ref.path}`
  function close(ref: ProjectFileRef) {
    if (isDraftDirty(store.get(ref))) { setClosing(ref); setError(undefined) }
    else store.close(ref, "discard")
  }
  async function saveClose(ref: ProjectFileRef) {
    setBusy(true)
    try { if (await onSave(ref)) { store.close(ref); setClosing(undefined) } else setError("未能儲存；分頁和草稿已保留。") }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <>
    <div className="editor-tabs" role="tablist" aria-label={pf("來源檔案分頁")}>{state.tabs.map((ref) => <div className="editor-tab" key={editorDraftKey(ref)}>
      <button type="button" role="tab" aria-selected={state.active && editorDraftKey(state.active) === editorDraftKey(ref)} onClick={() => store.open(ref)}>{label(ref)}{isDraftDirty(store.get(ref)) ? " ●" : ""}</button>
      <button type="button" className="link-button" aria-label={pf("關閉 {path}", { path: label(ref) })} onClick={() => close(ref)}>×</button>
    </div>)}</div>
    {closing ? <div role="dialog" aria-label={pf("關閉未儲存檔案 {path}", { path: label(closing) })} className="editor-close-choice">
      <p>{pf("{path} 有未儲存內容。", { path: label(closing) })}</p>
      {error ? <p role="alert">{pf(error)}</p> : null}
      <button type="button" disabled={busy || !roots.some((root) => root.workspaceId === closing.workspaceId)} onClick={() => void saveClose(closing)}>{pf("儲存並關閉")}</button>
      <button type="button" disabled={busy} onClick={() => { store.close(closing, "keep"); setClosing(undefined) }}>{pf("保留草稿並關閉")}</button>
      <button type="button" disabled={busy} onClick={() => { store.close(closing, "discard"); setClosing(undefined) }}>{pf("捨棄草稿並關閉")}</button>
      <button type="button" disabled={busy} onClick={() => setClosing(undefined)}>{pf("取消")}</button>
    </div> : null}
  </>
}
