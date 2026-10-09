import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
export interface TodoDraft {
  items: NonNullable<DesktopWorkStateView["todos"]>
  expectedRevision: number
  index: number | null
  content: string
}
interface TodoEditorState { draft: TodoDraft | null; saving: boolean; error?: string; pageOverride: number | null; snapshotIdentity?: string }
/** Retained UI state only; the displayed revision remains the write authority. */
export class TodoEditorStore {
  private state: TodoEditorState = { draft: null, saving: false, pageOverride: null }
  private listeners = new Set<() => void>()
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  update(patch: Partial<TodoEditorState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
