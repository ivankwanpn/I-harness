import { afterEach, expect, it } from "vitest"
import { createProcessTools } from "../src/tool.ts"
import { createTerminalService, type TerminalService } from "../src/service.ts"

let svc: TerminalService
afterEach(() => { svc?.dispose() })

it("process_spawn returns id+pid and process_kill TERM terminates", async () => {
  svc = createTerminalService()
  const tools = createProcessTools({ service: svc })
  const spawnTool = tools.find((t) => t.name === "process_spawn")!
  const killTool = tools.find((t) => t.name === "process_kill")!
  const spawned = (await spawnTool.execute({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, {})) as { id: string; pid: number }
  expect(spawned.pid).toBeGreaterThan(0)
  const view = (await killTool.execute({ id: spawned.id, signal: "TERM" }, {})) as { status: string }
  expect(view.status).toBe("running") // signal 是 async：exit 尚未觀察到 = 仍 running
  const exited = await svc.waitExited(spawned.id)
  expect(exited.exitCode).not.toBe(0)
})

it("process_resize_pty resizes a spawned process's pty", async () => {
  svc = createTerminalService()
  const tools = createProcessTools({ service: svc })
  const resizeTool = tools.find((t) => t.name === "process_resize_pty")!
  const spawnTool = tools.find((t) => t.name === "process_spawn")!
  const { id } = (await spawnTool.execute({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, {})) as { id: string }
  const out = await resizeTool.execute({ id, cols: 120, rows: 50 }, {})
  expect(out).toMatchObject({ id, cols: 120, rows: 50 })
})
