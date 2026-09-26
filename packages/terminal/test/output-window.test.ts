import { expect, it, vi } from "vitest"
const fake = vi.hoisted(() => ({ data: (_text: string) => {} }))
vi.mock("node-pty", () => ({ spawn: () => ({ pid: 1, onData: (handler: (text: string) => void) => { fake.data = handler }, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) }))
import { createTerminalService } from "../src/service.ts"
it("keeps absolute cursors after trimming a full output ring", () => {
  const service = createTerminalService()
  const terminal = service.open({ command: "fixture" })
  fake.data("a".repeat(1000001))
  const first = service.read(terminal.id, { offset: 0, maxBytes: 1000000 })
  expect(first.nextOffset).toBe(1000001)
  expect(first.dropped).toBe(true)
  fake.data("NEXT")
  expect(service.read(terminal.id, { offset: first.nextOffset }).data).toBe("NEXT")
  service.dispose()
})
it("preserves raw control sequences for a desktop terminal", () => {
  const service = createTerminalService()
  const terminal = service.open({ command: "fixture", rawOutput: true })
  fake.data("line\r\n\x1b[2J")
  expect(service.read(terminal.id).data).toBe("line\r\n\x1b[2J")
  service.dispose()
})
