// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { McpEditor } from "../src/renderer/settings/McpEditor.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"

beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })
const row = { enabled: false, revision: 19, config: { transport: "stdio" as const, serverName: "owned-server", command: "node", args: ["original.js"], cwd: "D:/owned", timeout: 4321 }, secretKeys: ["EXISTING_TOKEN"] }

it.each([
  ['["OWNED_PRIVATE_ARGUMENT",]', "參數的 JSON 格式有誤；請使用字串陣列。"],
  ['{"OWNED_PRIVATE_ARGUMENT":true}', "參數必須是 JSON 字串陣列。"],
  ['["server.js",23]', "參數必須是 JSON 字串陣列。"],
])("keeps invalid argument text and reports its field without echoing parser input: %s", (value, message) => {
  const save = vi.fn(async () => {})
  render(<McpEditor row={row} busy={false} onSave={save} onClose={() => {}} />)
  const args = screen.getByLabelText("參數（JSON 陣列）") as HTMLTextAreaElement
  fireEvent.change(args, { target: { value } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(screen.getByRole("alert").textContent).toBe(message)
  expect(screen.getByRole("alert").textContent).not.toContain("OWNED_PRIVATE_ARGUMENT")
  expect(args.value).toBe(value)
  expect(args.getAttribute("aria-invalid")).toBe("true")
  expect(args.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id)
  expect(document.activeElement).toBe(args)
  expect(save).not.toHaveBeenCalled()
})

it.each([
  ['{"OWNED_PRIVATE_OPTION":', "進階設定的 JSON 格式有誤；請使用物件。"],
  ['["OWNED_PRIVATE_OPTION"]', "進階設定必須是 JSON 物件"],
  ["null", "進階設定必須是 JSON 物件"],
])("opens and focuses the invalid advanced field without echoing its content: %s", (value, message) => {
  const save = vi.fn(async () => {})
  render(<McpEditor row={row} busy={false} onSave={save} onClose={() => {}} />)
  const advanced = screen.getByLabelText("進階設定（JSON）") as HTMLTextAreaElement
  const disclosure = advanced.closest("details")!
  expect(disclosure.open).toBe(false)
  fireEvent.change(advanced, { target: { value } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(screen.getByRole("alert").textContent).toBe(message)
  expect(screen.getByRole("alert").textContent).not.toContain("OWNED_PRIVATE_OPTION")
  expect(advanced.value).toBe(value)
  expect(disclosure.open).toBe(true)
  expect(advanced.getAttribute("aria-invalid")).toBe("true")
  expect(advanced.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id)
  expect(document.activeElement).toBe(advanced)
  expect(save).not.toHaveBeenCalled()
})

it("retries corrected text while preserving the complete command, private patch and revision", async () => {
  const save = vi.fn(async () => {})
  render(<McpEditor row={row} busy={false} onSave={save} onClose={() => {}} />)
  const args = screen.getByLabelText("參數（JSON 陣列）") as HTMLTextAreaElement
  fireEvent.change(args, { target: { value: "not-json" } })
  fireEvent.click(screen.getByText("環境變數", { selector: "summary" }))
  fireEvent.change(screen.getByLabelText("私密欄位名稱"), { target: { value: "OWNED_TOKEN" } })
  fireEvent.change(screen.getByLabelText("私密欄位值"), { target: { value: "owned-private-value" } })
  fireEvent.click(screen.getByRole("button", { name: "加入" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(args, { target: { value: '["next.js","--owned"]' } })
  expect(args.hasAttribute("aria-invalid")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ action: "save", revision: 19, config: { timeout: 4321, transport: "stdio", serverName: "owned-server", command: "node", args: ["next.js", "--owned"], cwd: "D:/owned" }, secrets: { env: { OWNED_TOKEN: "owned-private-value" } } }))
  expect(screen.queryByRole("alert")).toBeNull()
})

it("does not validate or send retained stdio arguments when the selected transport is HTTP", async () => {
  const save = vi.fn(async () => {})
  render(<McpEditor busy={false} onSave={save} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText("伺服器名稱"), { target: { value: "owned-http" } })
  fireEvent.change(screen.getByLabelText("參數（JSON 陣列）"), { target: { value: "not-json" } })
  fireEvent.change(screen.getByLabelText("連線方式"), { target: { value: "streamable-http" } })
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://owned.example/mcp" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ action: "save", revision: 0, config: { transport: "streamable-http", serverName: "owned-http", url: "https://owned.example/mcp" } }))
})
