// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SlashCommands } from "../src/renderer/session/SlashCommands.tsx"
afterEach(() => { cleanup(); vi.useRealTimers() })
it("refreshes enabled commands while open and removes a disabled command", async () => {
  vi.useFakeTimers()
  let enabled = true
  const select = vi.fn()
  const request = vi.fn(async () => enabled ? [{ name: "hello", description: "Greeting" }] : [])
  render(<SlashCommands bridge={{ request, onEvent: () => () => {} }} workspaceId="w" text="/" onSelect={select} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  fireEvent.click(screen.getByRole("button", { name: /hello/ }))
  expect(select).toHaveBeenCalledWith("hello")
  enabled = false
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.queryByRole("button", { name: /hello/ })).toBeNull()
})
