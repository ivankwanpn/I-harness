import { useEffect, useState } from "react"
import type { ProjectFileSelection, ProjectFilesRequester } from "../../../../desktop-gateway/src/project-files.ts"
import { absoluteReferencePath, type ExternalFileTarget } from "../session/file-navigation.ts"
import { checkedEditableSource } from "./project-file-responses.ts"
import { checkedSearchCancel, checkedSearchPreview, type SearchPreview as Preview } from "./content-search-results.ts"
import type { EditableSource } from "./SourceFileEditor.tsx"
import { ReadonlyFilePreview } from "./ReadonlyFilePreview.tsx"
import { SearchPreview } from "./SearchPreview.tsx"
import { useProjectFilesText } from "./project-files-text.ts"

/** An external reference has no editor identity, draft, revision ingestion or
 * save callback. All bytes arrive through explicit native read-only routes. */
export function ExternalFileViewer({ target, selection, request, onClose }: { target: ExternalFileTarget; selection: ProjectFileSelection; request: ProjectFilesRequester; onClose(): void }) {
  const pf = useProjectFilesText(), [refresh, setRefresh] = useState(0)
  const [reply, setReply] = useState<{ identity: string; source?: Extract<EditableSource, { kind: "text" }>; preview?: Preview; error?: string }>()
  const identity = JSON.stringify([selection, target.reference.path, target.navigation?.nonce, refresh])
  useEffect(() => {
    let valid = true, pending = false, cancelled = false
    const originalSelection = { ...selection }, requestId = crypto.randomUUID()
    function cancel() {
      if (!pending || cancelled) return
      cancelled = true
      try { void request({ ...originalSelection, kind: "desktop/project-files/content-cancel", requestId }).then(checkedSearchCancel).catch(() => {}) }
      catch { /* Native shutdown also drains captured jobs if the bridge is gone. */ }
    }
    void (async () => {
      try {
        const path = target.reference.path, navigation = target.navigation
        if (target.reference.readonly !== true || !absoluteReferencePath(path)) throw new Error("Invalid readonly reference file")
        let source: Extract<EditableSource, { kind: "text" }> | undefined, preview: Preview | undefined
        if (!navigation) {
          pending = true
          const value = checkedEditableSource(await request({ ...originalSelection, kind: "desktop/project-files/external-read", path, requestId }))
          pending = false
          if (!valid) return
          if (value.kind === "text") {
            if (value.readonly !== true || value.external !== true) throw new Error("External file read is not marked readonly")
            source = value
          }
        }
        if (!source) {
          if (!valid) return
          pending = true
          preview = checkedSearchPreview(await request({ ...originalSelection, kind: "desktop/project-files/external-preview", path, requestId, line: navigation?.line ?? 1, encoding: navigation?.encoding ?? "auto", ...(navigation?.revision ? { expectedRevision: navigation.revision } : {}) }))
          pending = false
          if (preview.external !== true) throw new Error("External preview is not marked readonly")
        }
        if (valid) setReply({ identity, source, preview })
      } catch (reason) { cancel(); if (valid) setReply({ identity, error: reason instanceof Error ? reason.message : String(reason) }) }
      finally { pending = false }
    })()
    return () => { valid = false; cancel() }
  }, [identity, request])
  const current = reply?.identity === identity ? reply : undefined
  return <section className="external-file-viewer" aria-label={pf("唯讀參考檔案")}>
    <div className="review-head"><p className="row-label">{target.reference.path}</p><button type="button" className="link-button" onClick={onClose}>{pf("關閉唯讀參考檔案")}</button></div>
    <button type="button" className="link-button" onClick={() => setRefresh(value => value + 1)}>{pf("重新讀取唯讀檔案")}</button>
    {!current ? <p role="status">{pf("正在讀取檔案…")}</p> : current.error ? <p role="alert" className="notice error-text">{current.error}</p> : current.preview ? <SearchPreview value={current.preview} navigation={target.navigation} /> : current.source ? <ReadonlyFilePreview value={current.source} /> : null}
  </section>
}
