import { useCallback, useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { removePending, upsertPending, type PendingInteraction } from "./pending.ts"
export function usePendingInteractions(bridge: DesktopBridge, workspaceId?: string) {
  const [pending, setPending] = useState<PendingInteraction[]>([])
  const scope = useRef({ workspaceId, version: 0, updates: new Map<string, { version: number; closed: boolean }>() })
  if (scope.current.workspaceId !== workspaceId) scope.current = { workspaceId, version: 0, updates: new Map() }
  useEffect(() => { setPending([]) }, [workspaceId])
  const update = useCallback((requestId: string, view?: PendingInteraction) => {
    if (scope.current.workspaceId !== workspaceId) return
    const state = scope.current
    state.updates.set(requestId, { version: ++state.version, closed: !view })
    if (state.updates.size > 2048) state.updates.delete(state.updates.keys().next().value!)
    setPending((current) => view ? upsertPending(current, view) : removePending(current, requestId))
  }, [workspaceId])
  const refresh = useCallback(async (sessionId?: string) => {
    if (!workspaceId) return
    const state = scope.current
    const started = state.version
    const rows = await bridge.request({ kind: "desktop/interaction/pending", workspaceId, ...(sessionId ? { sessionId } : {}) }) as PendingInteraction[]
    if (scope.current !== state) return
    setPending((current) => {
      let merged = current.filter((row) => (sessionId !== undefined && row.sessionId !== sessionId) || (state.updates.get(row.requestId)?.version ?? -1) > started)
      for (const row of rows) {
        const last = state.updates.get(row.requestId)
        if (last?.closed || (last?.version ?? -1) > started || (sessionId && row.sessionId !== sessionId)) continue
        merged = upsertPending(merged, row)
      }
      return merged
    })
  }, [bridge, workspaceId])
  return { pending, update, refresh }
}
