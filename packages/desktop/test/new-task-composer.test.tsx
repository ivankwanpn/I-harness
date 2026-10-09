// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { webcrypto } from "node:crypto"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); useUiStore.setState({ surface: "conversation", reviewOpen: false, locale: "zh-TW" }) })
it("offers image attachments only for the selected model's declared image input", async () => {
  const request = vi.fn(async (input: any) => {
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "text-model", inputModalities: ["text"] }, { id: "vision-model", inputModalities: ["text", "image"] }] }]
    if (input.kind === "workspace/attachments/pick") return { paths: [], images: [], texts: [] }
  })
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: "modality-draft", label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId="modality-draft"
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-input": ["1"], "prompt-context": ["1"], "prompt-images": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "text-model" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "選擇模型" })).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "workspace/attachments/pick", workspaceId: "modality-draft", allowImages: false }))
  fireEvent.click(screen.getByRole("button", { name: "text-model" }))
  fireEvent.click(await screen.findByRole("button", { name: "vision-model" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "選擇模型" })).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "workspace/attachments/pick", workspaceId: "modality-draft", allowImages: true }))
  expect(request.mock.calls.some(([input]) => input.kind === "session/create")).toBe(false)
})

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

it.each(["creation", "model"])("retains a newer model and reasoning draft after a delayed %s response and admission failure", async (stage) => {
  vi.stubGlobal("crypto", webcrypto)
  let release!: () => void
  const deferred = new Promise<void>((resolve) => { release = resolve })
  let first = true
  const request = vi.fn(async (input: any) => {
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "model-a" }, { id: "model-b" }] }]
    if (input.kind === "session/create") { if (stage === "creation") await deferred; return { sessionId: `delayed-${stage}` } }
    if (input.kind === "session/model/set" && stage === "model" && first) { first = false; await deferred }
    if (input.kind === "desktop/session/input/submit") throw new Error("retain model draft")
  })
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: `draft-${stage}`, label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId={`draft-${stage}`}
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-input": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Keep later selection" } })
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "model-a" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(request.mock.calls.some(([input]) => input.kind === (stage === "creation" ? "session/create" : "session/model/set"))).toBe(true))
  fireEvent.click(screen.getByRole("button", { name: /model-a/ }))
  fireEvent.click(await screen.findByRole("button", { name: "model-b" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  fireEvent.click(screen.getByRole("button", { name: "High" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：High" }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => release())
  await screen.findByText("retain model draft")
  expect(screen.getByRole("button", { name: /model-b/ })).toBeTruthy()
  expect(screen.getByRole("button", { name: "思考強度：High" })).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("Keep later selection")
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "session/model/set", workspaceId: `draft-${stage}`, sessionId: `delayed-${stage}`, selection: { provider: "fixture", model: "model-b", reasoningEffort: "high" } }))
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(1)
})
