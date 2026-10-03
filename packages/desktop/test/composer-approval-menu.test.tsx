// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer, clearDraft } from "../src/renderer/session/Composer.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { AgentSettingsState } from "@i-harness/desktop-gateway/src/agent-settings.ts"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); clearDraft("approval-ui", "owned"); localStorage.clear(); useLocale.getState().setLocale("zh-TW") })
const defaults = { sandboxMode: "read-only" as const, approvalMode: "dangerous" as const, autoCompaction: true }
function state(approvalMode: AgentSettingsState["effective"]["approvalMode"]): AgentSettingsState {
  const values = { ...defaults, approvalMode, sandboxMode: approvalMode === "full-access" ? "danger-full-access" as const : defaults.sandboxMode }
  return { saved: values, effective: values, restartRequired: false, source: "settings" }
}
function mount(handle: (request: DesktopRequest) => unknown) {
  const request = vi.fn(async (request: DesktopRequest) => handle(request))
  const onPrompt = vi.fn(async () => {}), onPermissionsChanged = vi.fn()
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const view = render(<Composer workspaceId="approval-ui" sessionId="owned" canSend running={false} bridge={bridge} fileReferencesEnabled permissionsEnabled onPrompt={onPrompt} onCancel={() => {}} onPermissionsChanged={onPermissionsChanged} />)
  return { request, onPrompt, onPermissionsChanged, view, bridge }
}

it("names the actual dangerous mode and sends only the chosen approval mode while applying effective scope", async () => {
  const initial = state("dangerous")
  const full = { sandboxMode: "danger-full-access" as const, approvalMode: "full-access" as const, autoCompaction: true }
  const f = mount(request => request.kind === "desktop/agent-settings/configure" ? { saved: full, effective: full, source: "settings", restartRequired: false } : initial)
  const trigger = await screen.findByRole("button", { name: "高風險時核准" })
  expect(screen.queryByRole("button", { name: "要求核准" })).toBeNull()
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "unsent prompt" } })
  fireEvent.click(trigger)
  expect(screen.getByRole("menuitemradio", { name: "高風險時核准" }).getAttribute("aria-checked")).toBe("true")
  expect(screen.queryByRole("combobox", { name: "沙箱" })).toBeNull()
  fireEvent.click(screen.getByRole("menuitemradio", { name: "完整存取權" }))
  await screen.findByRole("button", { name: "完整存取權" })
  expect(f.request).toHaveBeenCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "approval-ui", patch: { approvalMode: "full-access" } })
  expect(f.onPermissionsChanged).toHaveBeenCalledWith("danger-full-access")
  expect(f.onPrompt).not.toHaveBeenCalled()
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("unsent prompt")
  expect(screen.getAllByRole("button", { name: "送出" })).toHaveLength(1)
})

it("keeps the effective label and check when saved approval has not become effective", async () => {
  const initial = state("dangerous")
  const f = mount(request => request.kind === "desktop/agent-settings/configure" ? { ...initial, saved: { ...initial.saved, approvalMode: "delegate" }, restartRequired: true } : initial)
  fireEvent.click(await screen.findByRole("button", { name: "高風險時核准" }))
  fireEvent.click(screen.getByRole("menuitemradio", { name: "代我核准" }))
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("代我核准"))
  expect(screen.getByRole("button", { name: "高風險時核准" })).toBeTruthy()
  expect(screen.getByRole("menuitemradio", { name: "高風險時核准" }).getAttribute("aria-checked")).toBe("true")
  expect(screen.getByRole("menuitemradio", { name: "代我核准" }).getAttribute("aria-checked")).toBe("false")
  expect(f.onPermissionsChanged).toHaveBeenCalledWith("read-only")
})

it("serializes approval changes and preserves the effective choice and prompt after rejection", async () => {
  let reject!: (reason: Error) => void
  const f = mount(request => request.kind === "desktop/agent-settings/configure" ? new Promise((_resolve, fail) => { reject = fail }) : state("ask-all"))
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "keep this" } })
  fireEvent.click(await screen.findByRole("button", { name: "要求核准" }))
  fireEvent.click(screen.getByRole("menuitemradio", { name: "代我核准" }))
  expect((screen.getByRole("menuitemradio", { name: "完整存取權" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole("menuitemradio", { name: "完整存取權" }))
  expect(f.request.mock.calls.filter(([request]) => request.kind === "desktop/agent-settings/configure")).toHaveLength(1)
  await act(async () => reject(Error("Current policy declined approval change")))
  await screen.findByRole("alert")
  expect(screen.getByRole("menuitemradio", { name: "要求核准" }).getAttribute("aria-checked")).toBe("true")
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("keep this")
  expect(f.onPermissionsChanged).not.toHaveBeenCalled()
  expect(f.onPrompt).not.toHaveBeenCalled()
})

it("opens by keyboard, moves focus without changing policy and dismisses on Escape or outside pointer", async () => {
  const f = mount(() => state("ask-all"))
  const trigger = await screen.findByRole("button", { name: "要求核准" })
  trigger.focus(); fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const ask = screen.getByRole("menuitemradio", { name: "要求核准" })
  expect(document.activeElement).toBe(ask)
  fireEvent.keyDown(ask, { key: "ArrowDown" })
  const delegate = screen.getByRole("menuitemradio", { name: "代我核准" })
  expect(document.activeElement).toBe(delegate)
  fireEvent.keyDown(delegate, { key: "End" })
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "完整存取權" }))
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  const editor = screen.getByRole("textbox", { name: "提示" })
  editor.focus(); fireEvent.pointerDown(editor)
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(editor)
  expect(f.request.mock.calls.filter(([request]) => request.kind === "desktop/agent-settings/configure")).toHaveLength(0)
})

it("does not steal editor focus when an approval save completes after outside dismissal", async () => {
  let finish!: (state: AgentSettingsState) => void
  mount(request => request.kind === "desktop/agent-settings/configure" ? new Promise(resolve => { finish = resolve }) : state("ask-all"))
  fireEvent.click(await screen.findByRole("button", { name: "要求核准" }))
  fireEvent.click(screen.getByRole("menuitemradio", { name: "代我核准" }))
  const editor = screen.getByRole("textbox", { name: "提示" })
  editor.focus(); fireEvent.pointerDown(editor)
  await act(async () => finish(state("delegate")))
  await screen.findByRole("button", { name: "代我核准" })
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(editor)
})

it("ignores a saved reply from the old workspace instead of relabeling or applying its effective scope", async () => {
  let finish!: (state: AgentSettingsState) => void
  const f = mount(request => request.kind === "desktop/agent-settings/configure" ? new Promise(resolve => { finish = resolve }) : request.kind === "desktop/agent-settings/state" && request.workspaceId === "other" ? state("ask-all") : state("dangerous"))
  fireEvent.click(await screen.findByRole("button", { name: "高風險時核准" }))
  fireEvent.click(screen.getByRole("menuitemradio", { name: "完整存取權" }))
  f.view.rerender(<Composer workspaceId="other" sessionId="owned" canSend running={false} bridge={f.bridge} fileReferencesEnabled permissionsEnabled onPrompt={f.onPrompt} onCancel={() => {}} onPermissionsChanged={f.onPermissionsChanged} />)
  await screen.findByRole("button", { name: "要求核准" })
  await act(async () => finish(state("full-access")))
  expect(screen.getByRole("button", { name: "要求核准" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "完整存取權" })).toBeNull()
  expect(f.onPermissionsChanged).not.toHaveBeenCalled()
})

it("dismisses an initial-loading menu when Tab leaves the trigger before the late state can steal focus", async () => {
  let finish!: (state: AgentSettingsState) => void
  const f = mount(() => new Promise(resolve => { finish = resolve }))
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "ready to send" } })
  const trigger = screen.getByRole("button", { name: "核準模式" })
  trigger.focus(); fireEvent.keyDown(trigger, { key: "ArrowDown" })
  expect(screen.getByRole("menu")).toBeTruthy(); expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: "Tab" })
  // fireEvent does not perform the browser's native Tab traversal. The enabled
  // primary action is the actual next focus target in this owned Composer.
  const send = screen.getByRole("button", { name: "送出" })
  send.focus()
  await act(async () => finish(state("ask-all")))
  expect(document.activeElement).toBe(send); expect(screen.queryByRole("menu")).toBeNull()
  expect(f.onPrompt).not.toHaveBeenCalled()
})
