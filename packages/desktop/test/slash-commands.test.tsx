// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SlashCommands } from "../src/renderer/session/SlashCommands.tsx"
import { createRef } from "react"
import type { PickerKeyboard } from "../src/renderer/session/ContextPicker.tsx"

const page = (items: unknown[]) => ({ items, total: items.length, diagnostics: [] })
afterEach(() => { cleanup(); vi.useRealTimers() })
it("lists the built-in compact command when the gateway supports it", async () => {
  const select = vi.fn()
  render(<SlashCommands bridge={{ request: vi.fn().mockResolvedValue([]), onEvent: () => () => {} }} workspaceId="w" text="/com" showCompact onSelect={select} />)
  fireEvent.click(await screen.findByRole("option", { name: /compact/ }))
  expect(select).toHaveBeenCalledWith("compact")
})
it("refreshes enabled commands while open and removes a disabled command", async () => {
  vi.useFakeTimers()
  let enabled = true
  const select = vi.fn()
  const request = vi.fn(async () => page(enabled ? [{ name: "hello", kind: "command", source: "plugin", pluginId: "fixture", description: "Greeting" }] : []))
  render(<SlashCommands bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={select} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  fireEvent.click(screen.getByRole("option", { name: /hello/ }))
  expect(select).toHaveBeenCalledWith("hello")
  enabled = false
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.queryByRole("option", { name: /hello/ })).toBeNull()
})

it("offers enabled plugin skills in the slash menu using their native skill invocation", async () => {
  const select = vi.fn()
  const request = vi.fn(async input => String(input.kind) === "desktop/resources/suggestions" ? page([
    { name: "brainstorming", kind: "skill", description: "Explore ideas before building", source: "plugin", pluginId: "claude-plugins-official__superpowers" },
    { name: "review", kind: "command", description: "Review changes", source: "plugin", pluginId: "fixture" },
  ]) : [])
  render(<SlashCommands bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={select} />)
  const skill = await screen.findByRole("option", { name: /brainstorming/ })
  expect(skill.textContent).toContain("$brainstorming")
  expect(skill.textContent).toContain("superpowers")
  expect(screen.getByRole("option", { name: /\/review/ })).toBeTruthy()
  fireEvent.click(skill)
  expect(select).toHaveBeenCalledWith("brainstorming", "skill")
})

it("dynamically adds and withdraws plugin skills while the menu remains open", async () => {
  vi.useFakeTimers()
  let installed = false
  const request = vi.fn(async () => page(installed ? [{ name: "writing-plans", kind: "skill", source: "plugin", pluginId: "superpowers" }] : []))
  render(<SlashCommands bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={vi.fn()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.queryByRole("option", { name: /writing-plans/ })).toBeNull()
  installed = true
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.getByRole("option", { name: /writing-plans/ })).toBeTruthy()
  installed = false
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.queryByRole("option", { name: /writing-plans/ })).toBeNull()
})

it("clears the prior workspace catalogue before the new workspace response arrives", async () => {
  const pending = Promise.withResolvers<unknown>()
  const select = vi.fn(), ref = createRef<PickerKeyboard>()
  const request = vi.fn(async input => input.workspaceId === "first" ? page([{ name: "old-command", kind: "command", source: "workspace" }]) : pending.promise)
  const bridge = { request, onEvent: () => () => {} }
  const view = render(<SlashCommands ref={ref} bridge={bridge} workspaceId="first" text="/" onSelect={select} />)
  await screen.findByRole("option", { name: /old-command/ })
  view.rerender(<SlashCommands ref={ref} bridge={bridge} workspaceId="second" text="/" onSelect={select} />)
  expect(screen.queryByRole("option", { name: /old-command/ })).toBeNull()
  act(() => { ref.current?.key("Enter") })
  expect(select).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(page([])); await pending.promise })
})

it("does not let builtin command names hide an independent skill with the same name", async () => {
  const select = vi.fn()
  render(<SlashCommands bridge={{ request: vi.fn().mockResolvedValue(page([{ name: "compact", kind: "skill", source: "plugin", pluginId: "fixture" }])), onEvent: () => () => {} }} workspaceId="w" text="/" showCompact onSelect={select} />)
  const skill = await screen.findByRole("option", { name: /\$compact/ })
  expect(screen.getByRole("option", { name: /\/compact/ })).toBeTruthy()
  fireEvent.click(skill)
  expect(select).toHaveBeenCalledWith("compact", "skill")
})

it("keeps the keyboard selection attached to the same item after a live insertion", async () => {
  vi.useFakeTimers()
  let added = false
  const ref = createRef<PickerKeyboard>(), select = vi.fn()
  const request = vi.fn(async () => page([
    ...(added ? [{ name: "aardvark", kind: "command", source: "plugin" }] : []),
    { name: "alpha", kind: "command", source: "plugin" }, { name: "beta", kind: "command", source: "plugin" },
  ]))
  render(<SlashCommands ref={ref} bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={select} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  act(() => { ref.current?.key("ArrowDown") })
  added = true
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  act(() => { ref.current?.key("Enter") })
  expect(select).toHaveBeenCalledWith("beta")
})

it("clears unavailable plugin rows when refresh fails", async () => {
  vi.useFakeTimers()
  let fail = false
  const request = vi.fn(async () => { if (fail) throw new Error("Unavailable registry"); return page([{ name: "stale", kind: "command", source: "plugin" }]) })
  render(<SlashCommands bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={vi.fn()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByRole("option", { name: /stale/ })).toBeTruthy()
  fail = true
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.queryByRole("option", { name: /stale/ })).toBeNull()
  expect(screen.getByRole("alert").textContent).toContain("Unavailable registry")
})

it("withdraws the portal when the composer becomes hidden by a pending interaction", async () => {
  const anchor = createRef<HTMLTextAreaElement>()
  const bridge = { request: vi.fn().mockResolvedValue(page([{ name: "hello", kind: "command", source: "workspace" }])), onEvent: () => () => {} }
  const content = (hidden: boolean) => <div hidden={hidden}><textarea ref={anchor} /><SlashCommands anchorRef={anchor} bridge={bridge} workspaceId="w" text="/" onSelect={vi.fn()} /></div>
  const view = render(content(false))
  await screen.findByRole("option", { name: /hello/ })
  view.rerender(content(true))
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "可用命令" })).toBeNull())
  view.rerender(content(false))
  expect(await screen.findByRole("option", { name: /hello/ })).toBeTruthy()
})

it("dismisses with Escape while its diagnostics summary has focus", async () => {
  const anchor = createRef<HTMLTextAreaElement>()
  render(<><textarea ref={anchor} /><SlashCommands anchorRef={anchor} bridge={{ request: vi.fn().mockResolvedValue({ ...page([]), diagnostics: ["Fixture warning"] }), onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={vi.fn()} /></>)
  const summary = await screen.findByText("載入診斷")
  summary.focus()
  fireEvent.keyDown(summary, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "可用命令" })).toBeNull())
  expect(document.activeElement).toBe(anchor.current)
})
