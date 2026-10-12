// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { RuntimeLog } from "../src/renderer/settings/RuntimeLog.tsx"
import { RetrySettings } from "../src/renderer/settings/RetrySettings.tsx"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"

afterEach(() => { cleanup(); localStorage.clear() })
it("loads persistent native records, passes bounded filters and exports through the picker", async () => {
  const request = vi.fn(async action => action.kind === "desktop/diagnostics/list" ? { entries: [{ id: "final", timestamp: 1, level: "error", kind: "session/error", message: "Safe final failure", sessionId: "chat-a" }], storageError: "Safe storage warning" } : action.kind === "desktop/diagnostics/export" ? { exported: false, count: 0 } : { revealed: true })
  render(<RuntimeLog bridge={{ request }} />)
  await screen.findByText("Safe final failure"); expect(screen.getByText(/1,000/)).toBeTruthy()
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋診斷記錄" }), { target: { value: "503" } })
  fireEvent.change(screen.getByRole("combobox", { name: "嚴重程度" }), { target: { value: "error" } })
  fireEvent.change(screen.getByRole("textbox", { name: "會話 ID" }), { target: { value: "chat-a" } })
  fireEvent.click(screen.getByRole("button", { name: "重新整理" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/diagnostics/list", query: "503", level: "error", sessionId: "chat-a" }))
  fireEvent.click(screen.getByRole("button", { name: "匯出記錄" })); await screen.findByText("已取消匯出。")
  expect(request).toHaveBeenCalledWith({ kind: "desktop/diagnostics/export", query: "503", level: "error", sessionId: "chat-a" })
  fireEvent.click(screen.getByRole("button", { name: "開啟記錄資料夾" })); await screen.findByText("已開啟記錄資料夾。")
})

it("validates integer retry limits, retains draft after failed save, and confirms only saved values", async () => {
  let fail = true
  const request = vi.fn(async action => { if (action.kind === "desktop/global-retry/state") return { maxRetries: 5 }; if (fail) throw Error("unsafe backend detail"); return { maxRetries: action.maxRetries } })
  render(<RetrySettings bridge={{ request }} />)
  const input = await screen.findByRole("spinbutton", { name: "模型重試次數" }) as HTMLInputElement
  await waitFor(() => expect(input.value).toBe("5"))
  fireEvent.change(input, { target: { value: "2.5" } }); fireEvent.click(screen.getByRole("button", { name: "儲存重試設定" }))
  expect(screen.getByRole("alert").textContent).toContain("0 到 100")
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.change(input, { target: { value: "0" } }); fireEvent.click(screen.getByRole("button", { name: "儲存重試設定" }))
  await screen.findByText("無法儲存重試設定；輸入仍保留。")
  expect(input.value).toBe("0"); expect(screen.queryByText("unsafe backend detail")).toBeNull()
  expect(screen.getByText("已儲存重試次數：5")).toBeTruthy()
  fail = false; fireEvent.click(screen.getByRole("button", { name: "儲存重試設定" }))
  await screen.findByText("已儲存重試次數：0")
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/global-retry/configure", maxRetries: 0 })
  expect(screen.getByText(/下一次模型請求/)).toBeTruthy()
})

it("exposes retry settings and Log without a selected workspace", async () => {
  const request = vi.fn(async action => action.kind === "desktop/global-retry/state" ? { maxRetries: 5 } : action.kind === "desktop/diagnostics/list" ? { entries: [] } : {})
  render(<SettingsPane bridge={{ request, onEvent: () => () => {} }} onClose={() => {}} />)
  await screen.findByRole("spinbutton", { name: "模型重試次數" })
  fireEvent.click(screen.getByRole("button", { name: "診斷記錄" }))
  await screen.findByText("沒有符合的診斷記錄。")
})
