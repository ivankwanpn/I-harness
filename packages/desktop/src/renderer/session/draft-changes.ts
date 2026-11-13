export type DraftChangeSource = 'edit' | 'submission'
const listeners = new Set<(workspace: string, session: string, source: DraftChangeSource) => void>()
const retired = new Set<string>()
export function isDraftRetired(workspace: string, session: string) { return retired.has(JSON.stringify([workspace, session])) }
export function retireDraftScope(workspace: string, session: string) { retired.add(JSON.stringify([workspace, session])) }
export function publishDraftChange(workspace: string, session: string, source: DraftChangeSource = 'edit') { for (const listener of listeners) listener(workspace, session, source) }
export function subscribeDraftChanges(listener: (workspace: string, session: string, source: DraftChangeSource) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
