// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

const ENTRY: WorkspaceEntry = { id: "ws-1", path: "D:/workspace", label: "workspace" }

afterEach(cleanup)

function fakeBridge(): DesktopBridge {
  return {
    request: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => {}),
  }
}

function Harness(props: {
  dashboard: SessionDashboardResult
  capabilities?: Record<string, string[]>
}) {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  return (
    <Workbench
      bridge={fakeBridge()}
      workspaces={[ENTRY]}
      dashboard={props.dashboard}
      capabilities={props.capabilities ?? { "session-create": ["1"] }}
      sandbox={{ mode: "read-only", source: "settings", wired: true }}
      selectedWorkspaceId={ENTRY.id}
      selectedSessionId={sessionId}
      onSelectWorkspace={() => {}}
      onSelectSession={setSessionId}
    />
  )
}

describe("Desktop workbench shell", () => {
  it("says the session list is unavailable instead of showing zero sessions", () => {
    render(<Harness dashboard={{ sessions: [], listingUnavailable: true }} />)

    expect(screen.getByText("無法取得會話列表")).toBeTruthy()
    expect(screen.queryByText("尚無會話")).toBeNull()
  })

  it("says there are no sessions when the host really listed none", () => {
    render(<Harness dashboard={{ sessions: [] }} />)

    expect(screen.getByText("尚無會話")).toBeTruthy()
    expect(screen.queryByText("無法取得會話列表")).toBeNull()
  })

  it("selects a session row, announces it, and shows it in the central header", () => {
    render(
      <Harness dashboard={{
        sessions: [
          { id: "session-a", live: true },
          { id: "session-b", title: "第二個", live: false, turnCount: 3 },
        ],
      }} />,
    )

    expect(screen.getByTestId("session-header").textContent).toContain("尚未選擇會話")
    fireEvent.click(screen.getByRole("button", { name: /session-b/ }))

    expect(screen.getByTestId("session-header").textContent).toContain("session-b")
    expect(screen.getByTestId("session-announcer").textContent).toContain("session-b")
  })

  it("renders a disabled create control when the host lacks session-create", () => {
    render(<Harness dashboard={{ sessions: [] }} capabilities={{ "session-list": ["1"] }} />)

    const create = screen.getByRole("button", { name: "新增會話" })
    expect(create.hasAttribute("disabled")).toBe(true)
  })

  it("enables the create control when the host advertises session-create", () => {
    render(<Harness dashboard={{ sessions: [] }} />)

    const create = screen.getByRole("button", { name: "新增會話" })
    expect(create.hasAttribute("disabled")).toBe(false)
  })

  it("offers a folder control that asks the main process to open a workspace", () => {
    const bridge = fakeBridge()
    const request = vi.fn(async () => ({ id: "ws-2", path: "D:/other", label: "other" }))
    bridge.request = request

    render(
      <Workbench
        bridge={bridge}
        workspaces={[ENTRY]}
        dashboard={{ sessions: [] }}
        capabilities={{ "session-create": ["1"] }}
        selectedWorkspaceId={ENTRY.id}
        onSelectWorkspace={() => {}}
        onSelectSession={() => {}}
        onOpenWorkspace={() => { void bridge.request({ kind: "workspace/pick" }) }}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "開啟工作區" }))
    expect(request).toHaveBeenCalledWith({ kind: "workspace/pick" })
  })
})
