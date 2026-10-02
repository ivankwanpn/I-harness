// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { TaskList } from "../src/renderer/shell/TaskList.tsx"

afterEach(cleanup)
it("keeps the first menu open when clicked before mount passive effects settle", async () => {
  function FirstPaintClick() {
    useLayoutEffect(() => { screen.getByRole("button", { name: "更多會話操作 Fast chat" }).dispatchEvent(new MouseEvent("click", { bubbles: true })) }, [])
    return <TaskList workspaceId="w" dashboard={{ sessions: [{ id: "s", title: "Fast chat", live: false }] }} onSelect={() => {}} onOpenFolder={async () => {}} />
  }
  await act(async () => { render(<FirstPaintClick />) })
  expect(screen.getByRole("menuitem", { name: "開啟工作區資料夾" })).toBeTruthy()
})
