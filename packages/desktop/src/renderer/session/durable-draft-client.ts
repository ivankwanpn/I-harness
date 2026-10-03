import type { DraftRequester, DraftScope, DurableDraft, UnsentDraft } from "../../shared/attachment-drafts.ts"
const fingerprint = ({ metadata: _metadata, ...payload }: UnsentDraft) => JSON.stringify(payload)
/** A client lives beyond Composer mounts. Disk responses use the revision they
 * actually loaded; user edits are tracked while load/write/clear is in flight. */
export class DurableDraftClient {
  private revision: string | null = null
  private version = 0
  private dirty = false
  private loading?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private retired = false
  constructor(private readonly scope: DraftScope, private readonly request: DraftRequester, private read: () => UnsentDraft, private apply: (draft: UnsentDraft) => void, private status: (error?: string) => void) {}
  configure(read: () => UnsentDraft, apply: (draft: UnsentDraft) => void, status: (error?: string) => void) { this.read = read; this.apply = apply; this.status = status }
  retire() { this.retired = true; this.dirty = false; this.version++; clearTimeout(this.timer) }
  restore(): Promise<void> {
    if (this.retired) return Promise.resolve()
    if (this.loading) return this.loading
    const version = this.version
    const initial = this.read()
    this.loading = this.request({ kind: "desktop/draft/load", scope: this.scope }).then((record) => {
      if (this.retired) return
      this.check(record); this.revision = record.revision
      if (record.draft) {
        if (this.version === version) { this.apply(record.draft); this.dirty = false }
        else {
          // Typing during restore changes the prompt only; preserve independently
          // saved attachment groups whose current values were untouched.
          const current = this.read(), merged = { ...record.draft }
          for (const field of ["prompt", "references", "images", "texts", "contextRefs", "metadata"] as const) {
            if (JSON.stringify(current[field]) !== JSON.stringify(initial[field])) Object.assign(merged, { [field]: current[field] })
          }
          this.apply(merged); this.dirty = true
        }
      } else this.dirty = true
      this.status()
    }).catch((error) => { this.loading = undefined; this.report(error); throw error })
    return this.loading
  }
  changed() { if (this.retired) return; this.version++; this.dirty = true; clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush().catch(() => {}) }, 150) }
  capture(): string { return fingerprint(this.read()) }
  private check(record: DurableDraft) { if (!record || !((typeof record.revision === "string") || record.revision === null) || record.draft !== null && (!record.draft || typeof record.draft.prompt !== "string" || !Array.isArray(record.draft.images) || !Array.isArray(record.draft.texts) || !Array.isArray(record.draft.references) || !Array.isArray(record.draft.contextRefs))) throw new Error("Invalid durable draft response") }
  private report(error: unknown) { this.status(`Draft persistence failed; your in-memory draft is retained: ${error instanceof Error ? error.message : String(error)}`) }
  private async saveDirty() {
    while (this.dirty && !this.retired) {
      const version = this.version, snapshot = this.read()
      const record = await this.request({ kind: "desktop/draft/save", scope: this.scope, expectedRevision: this.revision, draft: snapshot })
      if (this.retired) return
      this.check(record); this.revision = record.revision
      if (version === this.version) this.dirty = false
    }
    this.status()
  }
  flush(): Promise<void> {
    clearTimeout(this.timer)
    const result = this.queue.then(async () => { if (this.retired) return; await this.restore(); await this.saveDirty() }).catch((error) => { if (!this.retired) this.report(error); throw error })
    this.queue = result.catch(() => {}); return result
  }
  admitted(sent: string, clearMemory: () => void): Promise<boolean> {
    clearTimeout(this.timer)
    const result = this.queue.then(async () => {
      if (this.retired) return false
      await this.restore()
      if (this.retired) return false
      if (this.capture() !== sent) return false
      await this.saveDirty()
      if (this.retired) return false
      if (this.capture() !== sent) return false
      const version = this.version
      const record = await this.request({ kind: "desktop/draft/clear", scope: this.scope, expectedRevision: this.revision })
      if (this.retired) return false
      this.check(record); this.revision = record.revision
      if (this.version !== version || this.capture() !== sent) return false
      clearMemory(); this.dirty = true
      await this.saveDirty()
      return true
    }).catch((error) => { this.report(error); throw error })
    this.queue = result.catch(() => {}); return result
  }
}
