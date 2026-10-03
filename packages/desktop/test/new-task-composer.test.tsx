// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { webcrypto } from "node:crypto"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); useUiStore.setState({ surface: "conversation", reviewOpen: false, locale: "zh-TW" }) })
it("keeps model, effort, text and attachment as a draft until submit; failed admission retries the same session and token", async () => {
  vi.stubGlobal("crypto", webcrypto)
  let attempt = 0
  const request = vi.fn(async (input: any) => {
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "offline-model" }] }]
    if (input.kind === "workspace/attachments/pick") return { paths: [], images: [], texts: [{ name: "notes.txt", text: "bounded fixture" }] }
    if (input.kind === "session/create") return { sessionId: "new-session" }
    if (input.kind === "desktop/session/input/submit") { if (++attempt === 1) throw new Error("admission unavailable"); return { admitted: true } }
  })
  const selected = vi.fn()
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: "draft-root", label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId="draft-root"
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-input": ["1"], "prompt-context": ["1"], "desktop-review": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={selected} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Keep complete draft" } })
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "offline-model" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  fireEvent.click(screen.getByRole("button", { name: "High" }))
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await screen.findByText("notes.txt")
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await screen.findByText("admission unavailable")
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("Keep complete draft")
  expect(screen.getByText("notes.txt")).toBeTruthy()
  expect(selected).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(selected).toHaveBeenCalledWith("new-session"))
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(1)
  const admissions = request.mock.calls.filter(([input]) => input.kind === "desktop/session/input/submit").map(([input]) => input)
  expect(admissions).toHaveLength(2)
  expect(admissions[0].clientToken).toBe(admissions[1].clientToken)
  expect(admissions[1].context).toContain("bounded fixture")
  expect(request).toHaveBeenCalledWith({ kind: "session/model/set", workspaceId: "draft-root", sessionId: "new-session", selection: { provider: "fixture", model: "offline-model", reasoningEffort: "high" } })
})
