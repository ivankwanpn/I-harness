import { afterEach, beforeEach, expect, it } from "vitest"
import { createTerminalService, type TerminalService } from "../src/service.ts"
import { createTerminalTools } from "../src/tool.ts"

// 注意：Win32 上 node -e 引數含 `'\n'` 轉義序列會被解析器 reject（本機 node 24.15 實測），
// 統統改用 String.fromCharCode(10) 產生 LF——零轉義、跨工具鏈穩定。
const ECHO_SCRIPT = [
  "process.stdin.on('data', d => { process.stdout.write('ECHO:' + d.toString().trim() + String.fromCharCode(10)) })",
  "process.stdout.write('READY' + String.fromCharCode(10))",
].join("\n")

let svc: TerminalService
beforeEach(() => { svc = createTerminalService() })
afterEach(() => { svc.dispose() })

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error("timed out waiting")
}

it("open + read: spawns a pty and exposes output (CRLF normalized)", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r = svc.read(t.id)
  expect(r.data).toContain("READY\n")
  expect(r.data).not.toContain("\r")
})

it("send: writes to stdin; terminal echo returns through read with offsets", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r0 = svc.read(t.id)
  svc.send(t.id, "hi\r") // ConPTY cooked mode：行終結符 = CR（Enter）——LF 單獨不會送達 stdin
  await waitFor(() => svc.read(t.id, { offset: r0.nextOffset }).data.includes("ECHO:hi"))
  const r1 = svc.read(t.id, { offset: r0.nextOffset })
  expect(r1.data).toContain("ECHO:hi")
  expect(r1.nextOffset).toBeGreaterThan(r0.nextOffset)
  // idempotent offsets：重讀同一 offset → 同資料
  expect(svc.read(t.id, { offset: r0.nextOffset }).data).toBe(r1.data)
})

it("read maxBytes truncates and raises nextOffset", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", `process.stdout.write('abcdefgh')`] })
  await waitFor(() => svc.read(t.id).data.includes("abcdefgh")) // 等載荷而非 ConPTY 初始化 ESC 序
  const full = svc.read(t.id).data
  const part = svc.read(t.id, { maxBytes: 3 })
  expect(part.truncated).toBe(true)
  expect(part.data.length).toBe(3)
  expect(part.nextOffset).toBe(3)
  expect(full).toContain("abcdefgh")
})

it("signal TERM: process exits; waitExited resolves", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] })
  const exited = svc.waitExited(t.id)
  svc.signal(t.id, "TERM")
  const res = await exited
  expect(res.exitCode).not.toBe(0)
  expect(svc.list().find((v) => v.id === t.id)?.status).toBe("exited")
})

it("resize: updates cols/rows on the view", () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "0"] })
  svc.resize(t.id, 100, 40)
  expect(svc.list().find((v) => v.id === t.id)).toMatchObject({ cols: 100, rows: 40 })
})

it("close: terminal disappears from list; unknown ids fail closed", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  svc.close(t.id)
  expect(svc.list().map((v) => v.id)).not.toContain(t.id)
  expect(() => svc.read(t.id)).toThrow(/TERMINAL_NOT_FOUND/)
  expect(() => svc.close(t.id)).toThrow(/TERMINAL_NOT_FOUND/)
})

it("owner scope: opened with sessionId, other sessions (and anonymous exec) are refused", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "0"] }, { sessionId: "sess-a" })
  expect(() => svc.send(t.id, "x", { sessionId: "sess-b" })).toThrow(/OWNER_MISMATCH/)
  expect(() => svc.send(t.id, "x")).toThrow(/OWNER_MISMATCH/)                     // 匿名執行視同非 owner
  expect(() => svc.close(t.id, { sessionId: "sess-b" })).toThrow(/OWNER_MISMATCH/)
  expect(() => svc.close(t.id, { sessionId: "sess-a" })).not.toThrow()
  // 未帶 sessionId 開啟的 terminal 不受限
  const t2 = svc.open({ command: process.execPath, args: ["-e", "0"] })
  expect(() => svc.send(t2.id, "x")).not.toThrow()
  svc.close(t2.id)
})

it("dispose: closes every terminal and pending waitExited reject", async () => {
  const t = svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  const w = svc.waitExited(t.id)
  svc.dispose()
  await expect(w).rejects.toThrow(/disposed/)
  expect(svc.list()).toEqual([])
})

it("tools: six terminal tools registered with exact names and forward args to the service", async () => {
  const service = createTerminalService()
  const tools = createTerminalTools({ service })
  expect(tools.map((t) => t.name)).toEqual([
    "terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list",
  ])
  const open = tools.find((t) => t.name === "terminal_open")!
  const send = tools.find((t) => t.name === "terminal_send")!
  const readTool = tools.find((t) => t.name === "terminal_read")!
  const run = (await open.execute({ command: process.execPath, args: ["-e", `process.stdout.write("X")`] }, {})) as { id: string }
  expect(((await send.execute({ id: run.id, data: "next" }, {})) as { sentChars: number }).sentChars).toBe(4)
  let data = ""
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { // offset-0 read 非消耗——可重讀輪詢
    data = String(((await readTool.execute({ id: run.id }, {})) as { data: string }).data ?? "")
    if (data.includes("X")) break
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(data).toContain("X")
  await tools.find((t) => t.name === "terminal_close")!.execute({ id: run.id }, {})
  expect(service.list()).toEqual([])
})
