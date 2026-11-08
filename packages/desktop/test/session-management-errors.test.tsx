// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { TaskList } from "../src/renderer/shell/TaskList.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
afterEach(() => { cleanup(); useUiStore.setState({ locale: "zh-TW" }) })
it.each(['zh-TW', 'en'] as const)('offers a single fork action in the existing action surface in %s', async locale => {
  useUiStore.setState({ locale })
  const manage = vi.fn(async () => {})
  render(<TaskList dashboard={{ sessions: [{ id: 's', title: 'First', live: false, turnCount: 1 }] }} onSelect={() => {}} onManage={manage} />)
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'More actions for First' : '更多會話操作 First' }))
  expect(screen.queryByRole('menuitem', { name: locale === 'en' ? 'Fork another conversation' : '建立另一個分支' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: locale === 'en' ? 'Fork conversation' : '建立分支' }))
  await vi.waitFor(() => expect(manage).toHaveBeenCalledExactlyOnceWith('s', 'fork', undefined))
})
it.each(["zh-TW", "en"] as const)("explains the pending rewind blocker without IPC framing in %s", async locale => {
  useUiStore.setState({ locale })
  render(<TaskList dashboard={{ sessions: [{ id: "s", title: "First", live: false }] }} onSelect={() => {}} onManage={async () => { throw new Error("Error invoking remote method 'desktop:request': RpcError: Session has a pending rewind recording") }} />)
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "More actions for First" : "更多會話操作 First" }))
  fireEvent.click(screen.getByRole("menuitem", { name: locale === "en" ? "Archive conversation" : "封存會話" }))
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).not.toContain("RpcError")
  expect(alert.textContent).toContain(locale === "en" ? "rewind recording" : "回復記錄")
  expect(alert.textContent).toContain(locale === "en" ? "retry" : "重試")
})
it("keeps a New session row visible and active", () => {
  const create = vi.fn()
  render(<TaskList dashboard={{ sessions: [{ id: "s", title: "First", live: false, turnCount: 1 }] }} onSelect={() => {}} onNewSession={create} newSessionActive />)
  const row = screen.getByRole("button", { name: /新會話/ })
  expect(row.getAttribute("aria-current")).toBe("true")
  fireEvent.click(row)
  expect(create).toHaveBeenCalledOnce()
})

it("keeps archive available while a conversation has pending messages", () => {
  render(<TaskList dashboard={{ sessions: [{ id: "s", title: "First", live: false, turnCount: 1 }] }} attentionCounts={{ s: 2 }} onSelect={() => {}} onManage={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
  const archive = screen.getByRole("menuitem", { name: "封存會話" }) as HTMLButtonElement
  expect(archive.disabled).toBe(false)
})

it("disables archive while a turn is running", () => {
  render(<TaskList dashboard={{ sessions: [{ id: "s", title: "First", live: true, running: true, turnCount: 1 }] }} onSelect={() => {}} onManage={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
  const archive = screen.getByRole("menuitem", { name: "封存會話" }) as HTMLButtonElement
  expect(archive.disabled).toBe(true)
  expect(archive.title).toContain("先停止目前回合")
})