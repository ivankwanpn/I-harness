// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { TaskList } from "../src/renderer/shell/TaskList.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
afterEach(() => { cleanup(); useUiStore.setState({ locale: "zh-TW" }) })
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
