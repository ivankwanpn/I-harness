// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopRequest } from "../src/shared/bridge.ts"
import { NewTaskComposer } from "../src/renderer/session/Composer.tsx"
import { writeFileReferences } from "../src/renderer/session/file-reference-drafts.ts"

afterEach(() => { cleanup(); localStorage.clear() })

it("retries an isolated draft with the same checkout intent and submits only to the returned workspace", async () => {
  const source = "source-for-worktree", projectId = "repo-for-worktree"
  const requests: DesktopRequest[] = []
  let createAttempts = 0
  const request = async (input: DesktopRequest): Promise<unknown> => {
    requests.push(input)
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", configured: true, selectedDefaultModel: "model", models: [{ id: "model" }] }]
    if (input.kind === "desktop/worktrees/list") return { source: { path: "D:/project", branch: "main", head: "a".repeat(40), locked: false, missing: false, dirty: false }, worktrees: [] }
    if (input.kind === "session/create") {
      if (++createAttempts === 1) throw new Error("reply lost")
      return { sessionId: "child-session", workspaceId: "linked-workspace" }
    }
    return {}
  }
  const submitted = vi.fn()
  render(<NewTaskComposer workspaceId={source} projectId={projectId} bridge={{ request, onEvent: () => () => {} }}
    capabilities={{ "session-create": ["1"], "desktop-input": ["1"], "desktop-draft-create": ["1"], "desktop-git-worktrees": ["1"] }} onSubmitted={submitted} />)
  fireEvent.click(await screen.findByRole("button", { name: "目前資料夾" }))
  const chooser = await screen.findByRole("combobox", { name: "會話工作目錄" })
  fireEvent.change(chooser, { target: { value: "create" } })
  const editor = screen.getByRole("textbox", { name: "提示" })
  fireEvent.change(editor, { target: { value: "Update the selected checkout" } })
  writeFileReferences(source, `new-task:${projectId}`, ["same.txt"])
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "送出" })
  await waitFor(() => expect(send.disabled).toBe(false))
  fireEvent.click(send)
  await waitFor(() => { expect(createAttempts).toBe(1); expect(send.disabled).toBe(false) })
  expect((chooser as HTMLSelectElement).disabled).toBe(true)
  fireEvent.click(send)
  await waitFor(() => expect(submitted).toHaveBeenCalledWith("child-session", "linked-workspace"))
  const created = requests.filter(input => input.kind === "session/create")
  expect(created).toHaveLength(2)
  expect(created[0]).toEqual(created[1])
  expect(created[1]).toMatchObject({ workspaceId: source, projectId, worktree: { mode: "create" } })
  const turns = requests.filter(input => input.kind === "desktop/session/input/submit")
  expect(turns).toHaveLength(1)
  expect(turns[0]).toMatchObject({ workspaceId: "linked-workspace", sessionId: "child-session", context: expect.stringContaining('"workspaceId": "linked-workspace"') })
})
