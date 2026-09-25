import { useCallback, useEffect, useState } from "react"
import type { SessionDashboardResult } from "@i-harness/sdk"
import type { SandboxState } from "../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../main/workspaces.ts"
import type { DesktopBridge } from "../shared/bridge.ts"
import { Workbench } from "./shell/Workbench.tsx"

/** The renderer data layer: it owns the bridge, the selection and the refresh
 * rules; the workbench below is a shell that renders exactly what it is told. */
export function App({ bridge }: { bridge: DesktopBridge }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [dashboard, setDashboard] = useState<SessionDashboardResult>()
  const [capabilities, setCapabilities] = useState<Record<string, string[]>>({})
  const [sandbox, setSandbox] = useState<SandboxState>()
  const [error, setError] = useState<string>()
  const [selectedSessionId, setSelectedSessionId] = useState<string>()

  const refreshDashboard = useCallback(async (workspaceId: string): Promise<void> => {
    const result = await bridge.request({ kind: "session/dashboard", workspaceId })
    setDashboard(result as SessionDashboardResult)
  }, [bridge])

  useEffect(() => {
    let active = true
    void bridge.request({ kind: "workspace/list" })
      .then((rows) => {
        if (!active) return
        const list = rows as WorkspaceEntry[]
        setWorkspaces(list)
        setSelectedWorkspaceId((current) => current ?? list[0]?.id)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { active = false }
  }, [bridge])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    let active = true
    void (async () => {
      try {
        const [dashboardResult, capabilitiesResult, sandboxResult] = await Promise.all([
          bridge.request({ kind: "session/dashboard", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "desktop/capabilities", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "workspace/sandbox/state", workspaceId: selectedWorkspaceId }),
        ])
        if (!active) return
        setDashboard(dashboardResult as SessionDashboardResult)
        setCapabilities((capabilitiesResult ?? {}) as Record<string, string[]>)
        setSandbox(sandboxResult as SandboxState | undefined)
        setError(undefined)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { active = false }
  }, [bridge, selectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    return bridge.onEvent((event) => {
      if (event.kind !== "sdk/notification" || event.workspaceId !== selectedWorkspaceId) return
      void refreshDashboard(event.workspaceId)
    })
  }, [bridge, refreshDashboard, selectedWorkspaceId])

  return (
    <Workbench
      bridge={bridge}
      workspaces={workspaces}
      dashboard={dashboard}
      capabilities={capabilities}
      sandbox={sandbox}
      error={error}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedSessionId={selectedSessionId}
      onSelectWorkspace={(workspaceId) => {
        setSelectedWorkspaceId(workspaceId)
        setSelectedSessionId(undefined)
        setDashboard(undefined)
      }}
      onSelectSession={setSelectedSessionId}
      onSessionsChanged={() => {
        if (selectedWorkspaceId !== undefined) void refreshDashboard(selectedWorkspaceId)
      }}
    />
  )
}
