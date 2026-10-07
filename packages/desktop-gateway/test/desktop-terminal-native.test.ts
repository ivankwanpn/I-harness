import { expect, it } from "vitest"
import { createDesktopTerminal } from "../src/terminal.ts"

it.skipIf(process.platform !== "win32")("human desktop terminal uses its own supervised ConPTY", async () => {
  const desktop = createDesktopTerminal(process.cwd())
  try {
    const opened = await desktop.request("desktop/terminal/open", { shell: "cmd", cols: 90, rows: 28 }) as { id: string; pid: number }
    expect(opened.pid).toBeGreaterThan(0)
    const resized = await desktop.request("desktop/terminal/resize", { id: opened.id, cols: 100, rows: 30 }) as unknown as { cols: number; rows: number; ownerSessionId: string }
    expect(resized).toMatchObject({ cols: 100, rows: 30, ownerSessionId: "desktop-user" })
    await desktop.request("desktop/terminal/write", { id: opened.id, data: "echo DESKTOP_NATIVE_CONTROL\r" })
    const deadline = Date.now() + 15_000
    let output = ""
    while (Date.now() < deadline) {
      const read = await desktop.request("desktop/terminal/read", { id: opened.id }) as { data: string }
      output = read.data
      if (output.includes("DESKTOP_NATIVE_CONTROL")) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(output).toContain("DESKTOP_NATIVE_CONTROL")
    const final = await desktop.request("desktop/terminal/close", { id: opened.id }) as unknown as { settlement: { kind: string; treeEmpty: boolean; ioSettled: boolean; resourcesReleased: boolean } }
    expect(final.settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
  } finally { await desktop.close() }
}, 25_000)
