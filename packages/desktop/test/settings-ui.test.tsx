// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { useAppearance, usePreferences } from "../src/renderer/design/preferences.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
afterEach(() => { cleanup(); localStorage.removeItem("ih:settings-section"); usePreferences.getState().reset(); useLocale.getState().setLocale("zh-TW") })

function View() { useAppearance(); return <SettingsPane onClose={() => {}} /> }
it("applies appearance and text size locally and resets them", () => {
  render(<View />)
  fireEvent.click(screen.getByRole("button", { name: "外觀" }))
  fireEvent.change(screen.getByRole("combobox", { name: "外觀" }), { target: { value: "light" } })
  expect(document.documentElement.dataset.theme).toBe("light")
  fireEvent.change(screen.getByLabelText("文字大小"), { target: { value: "18" } })
  expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("18px")
  expect(JSON.parse(localStorage.getItem("ih:ui-preferences")!)).toMatchObject({ appearance: "light", fontSize: 18 })
  fireEvent.click(screen.getByRole("button", { name: "重設外觀偏好" }))
  expect(document.documentElement.dataset.theme).toBe("dark")
  expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("14px")
})

it("follows system changes while system appearance is selected", () => {
  const callbacks: (() => void)[] = []
  const media = { matches: false, addEventListener: (_: string, callback: () => void) => callbacks.push(callback), removeEventListener: vi.fn() }
  const original = window.matchMedia
  window.matchMedia = vi.fn(() => media as unknown as MediaQueryList)
  try {
    const view = render(<View />)
    fireEvent.click(screen.getByRole("button", { name: "外觀" }))
    fireEvent.change(screen.getByRole("combobox", { name: "外觀" }), { target: { value: "system" } })
    expect(document.documentElement.dataset.theme).toBe("light")
    act(() => { media.matches = true; callbacks.at(-1)!() })
    expect(document.documentElement.dataset.theme).toBe("dark")
    view.unmount()
    expect(media.removeEventListener).toHaveBeenCalled()
  } finally { window.matchMedia = original }
})

it("opens models separately from workspace controls and remembers the selected section", () => {
  const view = render(<View />)
  fireEvent.click(screen.getByRole("button", { name: "模型與提供商" }))
  expect(screen.getByRole("heading", { name: "模型與提供商", level: 1 })).toBeTruthy()
  view.unmount()
  render(<View />)
  expect(screen.getByRole("button", { name: "模型與提供商" }).getAttribute("aria-current")).toBe("page")
})

it("routes workspace memory using the real workspace context", () => {
  const onMemory = vi.fn()
  render(<SettingsPane workspace={{ id: "play", label: "playground", path: "D:/agent-complete/playground" }} onMemory={onMemory} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "工作區" }))
  expect(screen.getByText("D:/agent-complete/playground")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "工作區記憶" }))
  expect(onMemory).toHaveBeenCalledTimes(1)
})

it("mounts only advertised Agent pages with the selected workspace", async () => {
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/memory/state" ? { enabled: false } : { notes: [] })
  render(<SettingsPane workspace={{ id: "play", label: "playground", path: "D:/agent-complete/playground" }} capabilities={{ "desktop-memory": ["1"] }} bridge={{ request, onEvent: () => () => {} }} onClose={() => {}} />)
  expect(screen.queryByRole("button", { name: "執行與上下文" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "記憶" }))
  await screen.findByRole("checkbox", { name: "啟用工作區記憶" })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/memory/state", workspaceId: "play" })
})
