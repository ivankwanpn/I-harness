import { createContext, useContext, type ReactNode } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useSessionContext } from "./use-session-context.ts"

type Reading = ReturnType<typeof useSessionContext>
const SessionReading = createContext<Reading | undefined>(undefined)

export function SessionContextScope({ bridge, workspaceId, sessionId, refreshKey, children }: {
  bridge: DesktopBridge; workspaceId?: string; sessionId?: string; refreshKey: string; children: ReactNode
}) {
  const reading = useSessionContext(bridge, workspaceId, sessionId, refreshKey)
  return <SessionReading.Provider value={workspaceId && sessionId ? reading : undefined}>{children}</SessionReading.Provider>
}

export function WithSessionContext({ children }: { children(usage: Reading): ReactNode }) {
  const reading = useContext(SessionReading)
  return reading ? children(reading) : null
}
