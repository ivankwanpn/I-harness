// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { TaskList } from "../src/renderer/shell/TaskList.tsx"
import { StrictMode } from "react"

afterEach(cleanup)
const dashboard = { sessions: [{ id: "s1", title: "First" }, { id: "s2", title: "Second" }] } as SessionDashboardResult

describe("sidebar session actions", () => {
  it("opens the selected row in session management for confirmed batch and permanent controls", () => {
    const manageSessions = vi.fn()
    render(<TaskList dashboard={dashboard} workspaceId="w" onSelect={() => {}} onManageSessions={manageSessions} />)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "管理此會話" }))
    expect(manageSessions).toHaveBeenCalledWith("s1")
    expect(screen.queryByRole("menu")).toBeNull()
  })
  it("disables fork before a completed turn and enables it when a turn has finished", async () => {
    const manage = vi.fn(async () => {})
    render(<TaskList dashboard={{ sessions: [{ id: "blank", title: "Blank", turnCount: 0 }, { id: "complete", title: "Complete", turnCount: 1 }] } as SessionDashboardResult} onSelect={() => {}} onManage={manage} />)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Blank" }))
    const blocked = screen.getByRole("menuitem", { name: "建立分支" }) as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(blocked.title).toBe("完成一輪後才能建立分支")
    fireEvent.click(blocked)
    expect(manage).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Complete" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "建立分支" }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith("complete", "fork", undefined))
  })
  it("keeps the archived list accessible when all active sessions are archived", () => {
    const archived = vi.fn()
    render(<TaskList dashboard={{ sessions: [] } as unknown as SessionDashboardResult} onSelect={() => {}} onManageArchived={archived} />)
    fireEvent.click(screen.getByRole("button", { name: "管理已封存會話" }))
    expect(archived).toHaveBeenCalledTimes(1)
  })

  it("closes an accepted action after StrictMode effect replay", async () => {
    render(<StrictMode><TaskList dashboard={dashboard} onSelect={() => {}} onManage={async () => {}} /></StrictMode>)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("prevents an in-flight action being repeated by reopening its row menu", async () => {
    let finish!: () => void
    const manage = vi.fn(() => new Promise<void>((done) => { finish = done }))
    render(<TaskList dashboard={dashboard} selectedId="s1" onSelect={() => {}} onManage={manage} />)
    const more = screen.getByRole("button", { name: "更多會話操作 First" }) as HTMLButtonElement
    fireEvent.click(more)
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    expect(more.disabled).toBe(true)
    fireEvent.click(more)
    expect(screen.getByRole("menu")).toBeTruthy()
    finish()
    await waitFor(() => expect(more.disabled).toBe(false))
  })

  it("opens actions from the more button and right-click without selecting another session", async () => {
    const select = vi.fn()
    const manage = vi.fn(async () => {})
    const view = render(<TaskList workspaceId="w1" dashboard={dashboard} onSelect={select} onManage={manage} />)
    expect(view.container.querySelector("button button")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith("s1", "pin", undefined))
    fireEvent.contextMenu(screen.getByText("Second"), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole("menuitem", { name: "標記為未讀" }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith("s2", "unread", undefined))
    expect(select).not.toHaveBeenCalled()
  })

  it("orders pinned rows first and renders an unread marker without modifying dashboard rows", () => {
    render(<TaskList dashboard={dashboard} navigation={{ s2: { pinned: true, unread: true } }} onSelect={() => {}} onManage={async () => {}} />)
    expect(screen.getAllByRole("listitem").map((row) => row.querySelector(".row-label")?.textContent)).toEqual(["Second", "First"])
    expect(screen.getByLabelText("未讀")).toBeTruthy()
    expect(dashboard.sessions.map((row) => row.id)).toEqual(["s1", "s2"])
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Second" }))
    expect(screen.getByRole("menuitem", { name: "取消釘選" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "標記為已讀" })).toBeTruthy()
  })

  it("uses an accessible rename dialog, keeps failed input, and submits the selected session", async () => {
    const manage = vi.fn(async () => { throw new Error("Session is busy") })
    render(<TaskList dashboard={dashboard} onSelect={() => {}} onManage={manage} />)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Second" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "重新命名" }))
    expect(screen.getByRole("dialog", { name: "重新命名" })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "Updated" } })
    fireEvent.click(screen.getByRole("button", { name: "儲存" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Session is busy")
    expect(manage).toHaveBeenCalledWith("s2", "rename", "Updated")
    expect((screen.getByLabelText("會話名稱") as HTMLInputElement).value).toBe("Updated")
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("supports keyboard context menu, arrow navigation, escape, and focus return", () => {
    render(<TaskList dashboard={dashboard} onSelect={() => {}} onManage={async () => {}} />)
    const row = screen.getByText("First").closest("button")!
    row.focus()
    fireEvent.keyDown(row, { key: "F10", shiftKey: true })
    const pin = screen.getByRole("menuitem", { name: "釘選會話" })
    expect(document.activeElement).toBe(pin)
    fireEvent.keyDown(pin, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重新命名" }))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it("keeps failures visible, prevents duplicate effects, and discards late workspace outcomes", async () => {
    let reject!: (error: Error) => void
    const manage = vi.fn(() => new Promise<void>((_done, fail) => { reject = fail }))
    const props = { dashboard, onSelect: () => {}, onManage: manage }
    const view = render(<TaskList {...props} workspaceId="w1" />)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    expect(manage).toHaveBeenCalledTimes(1)
    view.rerender(<TaskList {...props} workspaceId="w2" />)
    reject(new Error("old workspace error"))
    await waitFor(() => expect(screen.queryByText("old workspace error")).toBeNull())
    expect(screen.queryByRole("menu")).toBeNull()
    view.rerender(<TaskList {...props} workspaceId="w1" />)
    await waitFor(() => expect((screen.getByRole("button", { name: "更多會話操作 First" }) as HTMLButtonElement).disabled).toBe(false))
  })

  it("dismisses a project row's open action draft when its confirmed owner changes without changing native IDs", async () => {
    const manage = vi.fn(async () => {})
    const props = { dashboard: { sessions: [{ id: "opaque-row", title: "Moved history", live: false }] }, onSelect: () => {}, onManage: manage }
    const view = render(<TaskList {...props} rowScopes={{ "opaque-row": { workspaceId: "storage", sessionId: "native-id", projectId: "removed-a" } }} />)
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Moved history" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "重新命名" }))
    fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "Old owner draft" } })
    view.rerender(<TaskList {...props} rowScopes={{ "opaque-row": { workspaceId: "storage", sessionId: "native-id", projectId: "removed-b" } }} />)
    expect(screen.queryByRole("dialog", { name: "重新命名" })).toBeNull()
    expect(manage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Moved history" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith("native-id", "pin", undefined, { workspaceId: "storage", sessionId: "native-id", projectId: "removed-b" }))
  })

  it("routes archive, fork, copy ID and folder actions to their own targets", async () => {
    const manage = vi.fn(async () => {})
    const copy = vi.fn(async () => {})
    const open = vi.fn(async () => {})
    render(<TaskList dashboard={dashboard} onSelect={() => {}} onManage={manage} onCopyId={copy} onOpenFolder={open} />)
    for (const [label, action] of [["封存會話", "archive"], ["建立分支", "fork"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Second" }))
      fireEvent.click(screen.getByRole("menuitem", { name: label }))
      await waitFor(() => expect(manage).toHaveBeenCalledWith("s2", action, undefined))
    }
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "複製會話 ID" }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith("s1"))
    fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "開啟工作區資料夾" }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  })
})
