import { expect, it } from "vitest"
import { createTerminalTools } from "../src/tool.ts"
import type { TerminalService } from "../src/service.ts"

it("reports native PTY admission failures instead of suppressing diagnostic text", async () => {
  const unavailable = { open: async () => { throw new Error("PTY backend unavailable: AttachConsole failed") } } as unknown as TerminalService
  const open = createTerminalTools({ service: unavailable }).find(tool => tool.name === "terminal_open")!
  await expect(open.execute({ command: "fixture" }, {})).rejects.toThrow("PTY backend unavailable: AttachConsole failed")
})
