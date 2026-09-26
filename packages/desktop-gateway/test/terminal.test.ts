import { expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ open: vi.fn((_spec: unknown, _owner: unknown) => ({ id: "t", pid: 1 })), list: vi.fn(() => [] as unknown[]), read: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn(), dispose: vi.fn() }))
vi.mock("@i-harness/terminal", () => ({ createTerminalService: () => mock }))
import { createDesktopTerminal } from "../src/terminal.ts"
it("owns a fixed workspace shell and bounds terminal parameters", () => {
  const terminals = createDesktopTerminal("D:/agent-complete/playground")
  terminals.request("desktop/terminal/open", { cwd: "outside", command: "untrusted", cols: 80, rows: 24 })
  expect(mock.open).toHaveBeenCalledWith(expect.objectContaining({ cwd: "D:/agent-complete/playground", rawOutput: true, cols: 80, rows: 24 }), { sessionId: "desktop-user" })
  expect(mock.open.mock.calls[0]?.[0]).not.toMatchObject({ command: "untrusted" })
  expect(() => terminals.request("desktop/terminal/resize", { id: "t", cols: 0, rows: 24 })).toThrow()
  expect(() => terminals.request("desktop/terminal/write", { id: "t", data: "a".repeat(32769) })).toThrow()
  terminals.request("desktop/terminal/read", { id: "t", offset: 50 })
  expect(mock.read).toHaveBeenCalledWith("t", { sessionId: "desktop-user", offset: 50, maxBytes: 32768 })
  terminals.close()
  expect(mock.dispose).toHaveBeenCalledOnce()
  expect(() => terminals.request("desktop/terminal/list", {})).toThrow("closed")
})
