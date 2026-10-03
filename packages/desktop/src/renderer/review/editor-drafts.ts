import type { ProjectFileRef } from "../../../../desktop-gateway/src/project-files.ts"
import type { EditableSource, ReviewSaveResult } from "./SourceFileEditor.tsx"

export interface EditorDraft {
  ref: ProjectFileRef
  text: string
  original: string
  revision: string
  crlf: boolean
  bom: boolean
  external?: Extract<EditableSource, { kind: "text" }>
  error?: string
  saved?: boolean
}
export interface DraftSnapshot { drafts: Readonly<Record<string, EditorDraft>>; tabs: readonly ProjectFileRef[]; active?: ProjectFileRef; persistenceError?: string }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const editorDraftKey = (ref: ProjectFileRef) => JSON.stringify([ref.workspaceId, ref.path])
export const isDraftDirty = (draft: EditorDraft | undefined) => !!draft && draft.text !== draft.original
const normalize = (text: string) => text.replaceAll("\r\n", "\n").replace(/^\uFEFF/, "")
const STORAGE_KEY = "ih.project-file-drafts.v1"
const MAX_DRAFTS = 64, MAX_BYTES = 8 * 1024 * 1024
const editable = (value?: EditableSource): value is Extract<EditableSource, { kind: "text" }> => value?.kind === "text" && !value.truncated && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
function fromSource(ref: ProjectFileRef, value: Extract<EditableSource, { kind: "text" }>): EditorDraft {
  return { ref, text: normalize(value.text), original: normalize(value.text), revision: value.revision!, bom: value.text.startsWith("\uFEFF"), crlf: value.text.includes("\r\n") && !/(?<!\r)\n/.test(value.text) }
}
const validRef = (ref: unknown): ref is ProjectFileRef => !!ref && typeof ref === "object" && typeof (ref as ProjectFileRef).workspaceId === "string" && !!(ref as ProjectFileRef).workspaceId && typeof (ref as ProjectFileRef).path === "string" && !!(ref as ProjectFileRef).path

/** Lives outside panels. Only complete revisions create editable drafts. Reads
 * never replace dirty text; restart restoration retains its original CAS base. */
export class EditorDraftStore {
  private state: DraftSnapshot = { drafts: {}, tabs: [] }
  private listeners = new Set<() => void>()
  constructor(private storage?: DraftStorage) {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return
      if (raw.length > MAX_BYTES) throw new Error("Stored file drafts exceed the restore limit")
      const parsed = JSON.parse(raw) as DraftSnapshot
      const drafts: Record<string, EditorDraft> = {}
      for (const [key, value] of Object.entries(parsed.drafts ?? {}).slice(0, MAX_DRAFTS)) {
        if (validRef(value.ref) && editorDraftKey(value.ref) === key && typeof value.text === "string" && typeof value.original === "string" && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision) && typeof value.crlf === "boolean" && typeof value.bom === "boolean") drafts[key] = value
      }
      this.state = { drafts, tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter(validRef).slice(0, 32) : [], ...(validRef(parsed.active) ? { active: parsed.active } : {}) }
    } catch (error) { this.state = { ...this.state, persistenceError: `Cannot restore file drafts: ${String(error)}` } }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(ref: ProjectFileRef) { return this.state.drafts[editorDraftKey(ref)] }
  private publish(next: DraftSnapshot) {
    this.state = next
    try {
      const raw = JSON.stringify({ ...next, persistenceError: undefined })
      if (Object.keys(next.drafts).length > MAX_DRAFTS || raw.length > MAX_BYTES) throw new Error("Draft storage limit reached; save or discard file drafts")
      this.storage?.setItem(STORAGE_KEY, raw)
      if (next.persistenceError?.startsWith("File drafts are kept in memory") || next.persistenceError?.startsWith("Cannot restore file drafts")) this.state = { ...next, persistenceError: undefined }
    } catch (error) { this.state = { ...next, persistenceError: `File drafts are kept in memory; restart persistence failed: ${String(error)}` } }
    this.listeners.forEach((listener) => listener())
  }
  open(ref: ProjectFileRef) {
    const key = editorDraftKey(ref)
    const tabs = this.state.tabs.some((tab) => editorDraftKey(tab) === key) ? this.state.tabs : [...this.state.tabs, ref]
    if (tabs.length > 32) { this.publish({ ...this.state, persistenceError: "Close a file tab before opening more than 32 files" }); return }
    this.publish({ ...this.state, tabs, active: ref, persistenceError: undefined })
  }
  close(ref: ProjectFileRef, choice: "keep" | "discard" = "keep") {
    const key = editorDraftKey(ref), tabs = this.state.tabs.filter((tab) => editorDraftKey(tab) !== key)
    const drafts = { ...this.state.drafts }
    if (choice === "discard" || !isDraftDirty(drafts[key])) delete drafts[key]
    this.publish({ ...this.state, drafts, tabs, persistenceError: undefined, ...(this.state.active && editorDraftKey(this.state.active) === key ? { active: tabs.at(-1) } : {}) })
  }
  ingest(ref: ProjectFileRef, value?: EditableSource) {
    if (!editable(value)) return
    const key = editorDraftKey(ref), previous = this.get(ref)
    if (previous?.revision === value.revision) return
    const draft = isDraftDirty(previous) ? { ...previous!, external: value, error: "檔案已在外部變更，編輯內容已保留。請重新讀取後合併變更。" } : fromSource(ref, value)
    this.publish({ ...this.state, drafts: { ...this.state.drafts, [key]: draft } })
  }
  edit(ref: ProjectFileRef, text: string) {
    const draft = this.get(ref)
    if (draft) this.publish({ ...this.state, drafts: { ...this.state.drafts, [editorDraftKey(ref)]: { ...draft, text: normalize(text), saved: false } } })
  }
  feedback(ref: ProjectFileRef, error: string) {
    const draft = this.get(ref)
    if (draft) this.publish({ ...this.state, drafts: { ...this.state.drafts, [editorDraftKey(ref)]: { ...draft, error, saved: false } } })
  }
  discard(ref: ProjectFileRef, value?: EditableSource) {
    const drafts = { ...this.state.drafts }, key = editorDraftKey(ref)
    if (editable(value)) drafts[key] = fromSource(ref, value)
    else delete drafts[key]
    this.publish({ ...this.state, drafts })
  }
  /** Deliberate conflict resolution keeps the user's text and adopts the
   * freshly reviewed external revision as its CAS base. Never called by reload. */
  rebase(ref: ProjectFileRef) {
    const draft = this.get(ref)
    if (!draft?.external || !editable(draft.external)) return
    const base = fromSource(ref, draft.external)
    this.publish({ ...this.state, drafts: { ...this.state.drafts, [editorDraftKey(ref)]: { ...base, text: draft.text } } })
  }
  async save(ref: ProjectFileRef, operation: (text: string, revision: string) => Promise<ReviewSaveResult>): Promise<ReviewSaveResult> {
    const snapshot = this.get(ref)
    if (!snapshot || !isDraftDirty(snapshot)) return { kind: "unavailable", reason: "no-draft" }
    const encoded = `${snapshot.bom ? "\uFEFF" : ""}${snapshot.crlf ? snapshot.text.replaceAll("\n", "\r\n") : snapshot.text}`
    const result = await operation(encoded, snapshot.revision)
    if (result.kind === "saved") {
      const latest = this.get(ref)
      if (latest) this.publish({ ...this.state, drafts: { ...this.state.drafts, [editorDraftKey(ref)]: { ...latest, original: snapshot.text, revision: result.revision, external: undefined, error: undefined, saved: true } } })
    } else this.feedback(ref, result.kind === "conflict" ? "檔案已在外部變更，編輯內容已保留。請重新讀取後合併變更。" : `無法儲存檔案 (${result.reason})`)
    return result
  }
}
let persistentStore: EditorDraftStore | undefined
export function getEditorDraftStore() {
  if (!persistentStore) {
    let storage: DraftStorage | undefined
    try { if (typeof localStorage !== "undefined") storage = localStorage } catch { /* Report a persistence failure on the first draft write. */ }
    persistentStore = new EditorDraftStore(storage ?? { getItem: () => null, setItem: () => { throw new Error("Local draft storage unavailable") } })
  }
  return persistentStore
}
