// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TitleBar } from "../src/renderer/shell/TitleBar.tsx"
import { NativeSettings } from "../src/renderer/settings/NativeSettings.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { Composer } from "../src/renderer/session/Composer.tsx"
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); useUiStore.setState({ followupDelivery: "queue" } as never) })
it("sends only the selected native window action", () => {
  const request = vi.fn(async () => ({}))
  render(<TitleBar bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "最小化視窗" }))
  expect(request).toHaveBeenCalledWith({ kind: "window/control", action: "minimize" })
})
it("reads and updates notification preferences and can reset window bounds", async () => {
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/terminal/options"
    ? [{ id: "auto", label: "自動選擇", command: "C:\\Git\\bash.exe" }]
    : { notifications: false, notificationsSupported: true })
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} />)
  await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("checkbox"))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", notifications: true, locale: "zh-TW" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "重設視窗" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "重設視窗" }))
  expect(request).toHaveBeenCalledWith({ kind: "window/reset-bounds" })
})
it("lists detected terminal shells and saves the selection for new terminals", async () => {
  const request = vi.fn(async (value: { kind: string; terminalShell?: string }) => value.kind === "desktop/terminal/options"
    ? [{ id: "auto", label: "自動選擇", command: "C:\\Program Files\\Git\\bin\\bash.exe" }, { id: "git-bash", label: "Git Bash", command: "C:\\Program Files\\Git\\bin\\bash.exe" }, { id: "cmd", label: "CMD", command: "C:\\Windows\\System32\\cmd.exe" }]
    : { notifications: false, notificationsSupported: true, terminalShell: value.terminalShell ?? "auto" })
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} section="window" />)
  const select = await screen.findByRole("combobox", { name: "整合終端 Shell" })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/terminal/options" })
  expect(screen.getByText(/Windows 自動優先 Git Bash/)).toBeTruthy()
  expect(screen.getByText("C:\\Program Files\\Git\\bin\\bash.exe")).toBeTruthy()
  fireEvent.change(select, { target: { value: "git-bash" } })
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", terminalShell: "git-bash" }))
  fireEvent.change(select, { target: { value: "cmd" } })
  await waitFor(() => expect(screen.getByText("C:\\Windows\\System32\\cmd.exe")).toBeTruthy())
})
it("saves a terminal font override and allows clearing it back to the default", async () => {
  const request = vi.fn(async (value: { kind: string; terminalFontFamily?: string }) => value.kind === "desktop/terminal/options"
    ? [{ id: "auto", label: "自動選擇", command: "C:\\Program Files\\Git\\bin\\bash.exe" }]
    : { notifications: false, notificationsSupported: true, terminalShell: "auto", terminalFontFamily: value.terminalFontFamily ?? "" })
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} section="window" />)
  const field = await screen.findByRole("textbox", { name: "終端字體" })
  fireEvent.change(field, { target: { value: "Cascadia Code, monospace" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存終端字體" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", terminalFontFamily: "Cascadia Code, monospace" }))
  fireEvent.change(field, { target: { value: "" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存終端字體" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", terminalFontFamily: "" }))
})
it("keeps shell and font settings available before a workspace is opened", async () => {
  const request = vi.fn(async (value: { kind: string; terminalShell?: string }) => value.kind === "desktop/terminal/options"
    ? [{ id: "auto", label: "自動選擇", command: "C:\\Program Files\\Git\\bin\\bash.exe" }, { id: "git-bash", label: "Git Bash", command: "C:\\Program Files\\Git\\bin\\bash.exe" }]
    : { notifications: false, notificationsSupported: true, terminalShell: value.terminalShell ?? "auto", terminalFontFamily: "" })
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} section="window" />)
  expect(await screen.findByRole("textbox", { name: "終端字體" })).toBeTruthy()
  const select = await screen.findByRole("combobox", { name: "整合終端 Shell" })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/terminal/options" })
  fireEvent.change(select, { target: { value: "git-bash" } })
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", terminalShell: "git-bash" }))
})

it("saves the General follow-up default and applies it to a mounted composer's next send", async () => {
  const onPrompt = vi.fn(async () => {})
  const onSteer = vi.fn(async () => {})
  const request = vi.fn(async (value: { kind: string; followupDelivery?: "queue" | "steer" }) => value.kind === "desktop/terminal/options"
    ? [{ id: "auto", label: "Auto" }]
    : { notifications: false, notificationsSupported: true, followupDelivery: value.followupDelivery ?? "queue" })
  render(<><NativeSettings bridge={{ request, onEvent: () => () => {} }} section="window" /><Composer workspaceId="native-followup" sessionId="live" running canSend steeringEnabled onPrompt={onPrompt} onSteer={onSteer} onCancel={() => {}} /></>)
  const setting = await screen.findByRole("combobox", { name: "後續訊息處理方式" })
  await waitFor(() => expect((setting as HTMLSelectElement).disabled).toBe(false))
  fireEvent.change(setting, { target: { value: "steer" } })
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", followupDelivery: "steer" }))
  await waitFor(() => expect(useUiStore.getState().followupDelivery).toBe("steer"))
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "guide active work" } })
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(onSteer).toHaveBeenCalledWith("guide active work", undefined, undefined, expect.any(Function)))
  expect(onPrompt).not.toHaveBeenCalled()
})

it("retains the accepted follow-up default when saving a different setting fails", async () => {
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind === "desktop/terminal/options") return [{ id: "auto", label: "Auto" }]
    if (value.kind === "desktop/local/configure") throw new Error("preferences write failed")
    return { notifications: false, notificationsSupported: true, followupDelivery: "steer" }
  })
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} section="window" />)
  const setting = await screen.findByRole("combobox", { name: "後續訊息處理方式" })
  await waitFor(() => expect(useUiStore.getState().followupDelivery).toBe("steer"))
  fireEvent.change(setting, { target: { value: "queue" } })
  await screen.findByRole("alert")
  expect((setting as HTMLSelectElement).value).toBe("steer")
  expect(useUiStore.getState().followupDelivery).toBe("steer")
})
