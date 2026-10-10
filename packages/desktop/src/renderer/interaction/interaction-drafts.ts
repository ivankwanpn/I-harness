export interface InteractionDraft { selected: string; answer: string; busy: boolean; error?: string }
const empty: InteractionDraft = { selected: "", answer: "", busy: false }
class InteractionDraftStore {
  private state: Readonly<Record<string, InteractionDraft>> = {}
  private listeners = new Set<() => void>()
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(key: string) { return this.state[key] ?? empty }
  update(key: string, patch: Partial<InteractionDraft>) {
    this.state = { ...this.state, [key]: { ...this.get(key), ...patch } }
    this.emit()
  }
  accepted(key: string, submitted: InteractionDraft) {
    const current = this.get(key)
    if (current.selected === submitted.selected && current.answer === submitted.answer) {
      const next = { ...this.state }; delete next[key]; this.state = next; this.emit()
    } else this.update(key, { busy: false, error: undefined })
  }
  private emit() { for (const listener of this.listeners) listener() }
}
// The renderer connection owns pending human answers and operations in RAM.
// No answer, decision or private content is serialized to browser storage.
const stores = new WeakMap<object, InteractionDraftStore>()
export function interactionDrafts(owner: object): InteractionDraftStore {
  let store = stores.get(owner)
  if (!store) { store = new InteractionDraftStore(); stores.set(owner, store) }
  return store
}
export const interactionDraftKey = (workspaceId: string | undefined, sessionId: string, requestId: string) => JSON.stringify([workspaceId ?? "", sessionId, requestId])
