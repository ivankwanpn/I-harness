import { afterEach, beforeEach, expect, it } from "vitest"
import { createTerminalService, type TerminalService } from "../src/service.ts"
import { createExecService, withExecCallerScope } from "@i-harness/exec"
import { createTerminalTools, createProcessTools } from "../src/tool.ts"
import { basename, delimiter, dirname } from "node:path"
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs"
import { join, resolve, sep } from "node:path"

// 注意：Win32 上 node -e 引數含 `'\n'` 轉義序列會被解析器 reject（本機 node 24.15 實測），
// 統統改用 String.fromCharCode(10) 產生 LF——零轉義、跨工具鏈穩定。
const ECHO_SCRIPT = [
  "process.stdin.on('data', d => { process.stdout.write('ECHO:' + d.toString().trim() + String.fromCharCode(10)) })",
  "process.stdout.write('READY' + String.fromCharCode(10))",
].join("\n")

let svc: TerminalService
let execution: ReturnType<typeof createExecService>
beforeEach(() => { execution = createExecService(); svc = createTerminalService(execution) })
afterEach(async () => { await svc.dispose(); await execution.dispose() })

// `ms` covers a ConPTY spawn, not just the assertion: measured on 2026-10-05 this
// host takes ~5.7s to bring up a pwsh pty (a bare `pwsh` resolves to the MSIX
// package exe on PATH entry 0) and ~4.8s for fs-search's ripgrep suites, so a 5s
// deadline fails on slowness. The 30_000 ceiling matches the precedent already in
// workspace-cwd.test.ts for PTY tests.
async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error("timed out waiting")
}

it("open + read: spawns a pty and exposes output (CRLF normalized)", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r = svc.read(t.id)
  expect(r.data).toContain("READY\n")
  expect(r.data).not.toContain("\r")
})

it.skipIf(process.platform !== "win32")("opens a bare executable found on PATH through ConPTY", async () => {
  const t = await svc.open({
    command: basename(process.execPath),
    args: ["-e", "console.log('BARE_PATH_OK')"],
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` } as Record<string, string>,
  })
  await waitFor(() => svc.read(t.id).data.includes("BARE_PATH_OK"))
  expect(svc.read(t.id).data).toContain("BARE_PATH_OK")
}, 20_000)

it.skipIf(process.platform !== "win32" || !(process.env.PATH ?? "").split(";").some((part) => existsSync(`${part}\\pwsh.exe`)))("opens pwsh by its user-facing command name", async () => {
  const t = await svc.open({ command: "pwsh", args: ["-NoLogo", "-NoProfile", "-Command", "Get-Location"] })
  await waitFor(() => svc.read(t.id).data.includes("Path"))
  expect(svc.read(t.id).data).toContain("Path")
}, 30_000)

it("send: writes to stdin; terminal echo returns through read with offsets", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", ECHO_SCRIPT] })
  await waitFor(() => svc.read(t.id).data.includes("READY"))
  const r0 = svc.read(t.id)
  await svc.send(t.id, "hi\r") // ConPTY cooked mode：行終結符 = CR（Enter）——LF 單獨不會送達 stdin
  await waitFor(() => svc.read(t.id, { offset: r0.nextOffset }).data.includes("ECHO:hi"))
  const r1 = svc.read(t.id, { offset: r0.nextOffset })
  expect(r1.data).toContain("ECHO:hi")
  expect(r1.nextOffset).toBeGreaterThan(r0.nextOffset)
  // idempotent offsets：重讀同一 offset → 同資料
  expect(svc.read(t.id, { offset: r0.nextOffset }).data).toBe(r1.data)
})

it("read maxBytes truncates and raises nextOffset", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", `process.stdout.write('abcdefgh')`] })
  await waitFor(() => svc.read(t.id).data.includes("abcdefgh")) // 等載荷而非 ConPTY 初始化 ESC 序
  const full = svc.read(t.id).data
  const part = svc.read(t.id, { maxBytes: 3 })
  expect(part.truncated).toBe(true)
  expect(part.data.length).toBe(3)
  expect(part.nextOffset).toBe(3)
  expect(full).toContain("abcdefgh")
})

it("signal TERM: process exits; waitExited resolves", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] })
  const exited = svc.waitExited(t.id)
  await svc.signal(t.id, "TERM")
  const res = await exited
  expect(res.exitCode).not.toBe(0)
  expect(svc.list().find((v) => v.id === t.id)?.status).toBe("exited")
})

it.skipIf(process.platform !== "win32")("real ConPTY INT reaches the interactive root", async () => {
  const script = "process.on('SIGINT',()=>{console.log('INT_RECEIVED');process.exit(23)});console.log('INT_READY');setInterval(()=>{},1000)"
  const terminal = await svc.open({ command: process.execPath, args: ["-e", script] })
  await waitFor(() => svc.read(terminal.id).data.includes("INT_READY"))
  await svc.signal(terminal.id, "INT")
  await waitFor(() => svc.read(terminal.id).data.includes("INT_RECEIVED"))
  expect((await svc.waitExited(terminal.id)).exitCode).toBe(23)
}, 20_000)

it.skipIf(process.platform !== "win32")("retains a descendant after root exit until native settlement", async () => {
  const fixtureRoot = resolve(process.cwd(), ".tmp")
  mkdirSync(fixtureRoot, { recursive: true })
  const fixture = mkdtempSync(join(fixtureRoot, "sandbox-redesign-terminal-retain-"))
  const marker = join(fixture, "descendant.txt")
  try {
    const helper = resolve(process.cwd(), "../sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe")
    expect(existsSync(helper)).toBe(true)
    const terminal = await svc.open({ command: helper, args: ["--self-child", "spawn-descendant", "750", marker] })
    expect((await svc.waitExited(terminal.id)).exitCode).toBe(17)
    const afterRoot = svc.list().find(view => view.id === terminal.id)!
    expect(afterRoot.status).toBe("exited")
    expect(afterRoot.settlement?.kind).not.toBe("settled")
    expect(existsSync(marker)).toBe(false)
    await waitFor(() => existsSync(marker))
    await waitFor(() => svc.list().find(view => view.id === terminal.id)?.settlement?.kind === "settled")
    expect(svc.list().find(view => view.id === terminal.id)?.settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
  } finally {
    const actual = realpathSync.native(fixture)
    if (!actual.startsWith(realpathSync.native(fixtureRoot) + sep)) throw new Error("Fixture cleanup escaped workspace .tmp")
    rmSync(actual, { recursive: true, force: true })
  }
}, 20_000)

it.skipIf(process.platform !== "win32")("close cancels a retained ConPTY descendant before it writes", async () => {
  const fixtureRoot = resolve(process.cwd(), ".tmp")
  mkdirSync(fixtureRoot, { recursive: true })
  const fixture = mkdtempSync(join(fixtureRoot, "sandbox-redesign-terminal-cancel-"))
  const marker = join(fixture, "cancelled-descendant.txt")
  try {
    const helper = resolve(process.cwd(), "../sandbox-windows-psec/artifacts/win32-x64/i-harness-windows-helper.exe")
    expect(existsSync(helper)).toBe(true)
    const terminal = await svc.open({ command: helper, args: ["--self-child", "spawn-descendant", "5000", marker] })
    expect((await svc.waitExited(terminal.id)).exitCode).toBe(17)
    const final = await svc.close(terminal.id)
    expect(final.settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    expect(existsSync(marker)).toBe(false)
    expect(svc.list().some(view => view.id === terminal.id)).toBe(false)
  } finally {
    const actual = realpathSync.native(fixture)
    if (!actual.startsWith(realpathSync.native(fixtureRoot) + sep)) throw new Error("Fixture cleanup escaped workspace .tmp")
    rmSync(actual, { recursive: true, force: true })
  }
}, 20_000)

it("resize: updates cols/rows on the view", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  await svc.resize(t.id, 100, 40)
  expect(svc.list().find((v) => v.id === t.id)).toMatchObject({ cols: 100, rows: 40 })
})

it("close: terminal disappears from list; unknown ids fail closed", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  await svc.close(t.id)
  expect(svc.list().map((v) => v.id)).not.toContain(t.id)
  expect(() => svc.read(t.id)).toThrow(/TERMINAL_NOT_FOUND/)
  await expect(svc.close(t.id)).rejects.toThrow(/TERMINAL_NOT_FOUND/)
})

it("owner scope: opened with sessionId, other sessions (and anonymous exec) are refused", async () => {
  const t = await withExecCallerScope({ sessionId: "sess-a" }, () => svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, { sessionId: "sess-a" }))
  expect(svc.list({ sessionId: "sess-b" })).toEqual([])
  expect(svc.list({ sessionId: "sess-a" })).toEqual([expect.objectContaining({ id: t.id })])
  expect(() => withExecCallerScope({ sessionId: "sess-a" }, () => svc.list({ sessionId: "sess-b" }))).toThrow(/OWNER_MISMATCH/)
  await expect(svc.send(t.id, "x", { sessionId: "sess-b" })).rejects.toThrow(/OWNER_MISMATCH/)
  await expect(svc.send(t.id, "x")).rejects.toThrow(/OWNER_MISMATCH/)
  await expect(svc.close(t.id, { sessionId: "sess-b" })).rejects.toThrow(/OWNER_MISMATCH/)
  await expect(svc.close(t.id, { sessionId: "sess-a" })).resolves.toMatchObject({ id: t.id })
  // 未帶 sessionId 開啟的 terminal 不受限
  const t2 = await svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  await expect(svc.send(t2.id, "x")).resolves.toBeUndefined()
  await svc.close(t2.id)
})

it("dispose: closes every terminal and pending waitExited reject", async () => {
  const t = await svc.open({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] })
  const w = svc.waitExited(t.id)
  await svc.dispose()
  await expect(w).resolves.toMatchObject({ exitCode: expect.any(Number) })
  expect(svc.list()).toEqual([])
})

it("D1: terminal_open/process_spawn default cwd to the configured workspace; explicit args.cwd wins", async () => {
  const specs: Array<Record<string, unknown>> = []
  const spy = {
    open: (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { id: "t1", pid: 1, cols: 80, rows: 24 }
    },
  } as unknown as TerminalService
  const openTool = createTerminalTools({ service: spy, cwd: "/ws" }).find((t) => t.name === "terminal_open")!
  const spawnTool = createProcessTools({ service: spy, cwd: "/ws" }).find((t) => t.name === "process_spawn")!
  await openTool.execute({ command: "bash" }, {})
  await openTool.execute({ command: "bash", cwd: "/explicit" }, {})
  await spawnTool.execute({ command: "bash" }, {})
  expect(specs.map((s) => s.cwd)).toEqual(["/ws", "/explicit", "/ws"])
})

it("D1: no workspace cwd → no cwd field (the PTY inherits the process cwd)", async () => {
  const specs: Array<Record<string, unknown>> = []
  const spy = {
    open: (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { id: "t1", pid: 1, cols: 80, rows: 24 }
    },
  } as unknown as TerminalService
  const openTool = createTerminalTools({ service: spy }).find((t) => t.name === "terminal_open")!
  await openTool.execute({ command: "bash" }, {})
  expect(specs[0]!.cwd).toBeUndefined()
})

it("tools: six terminal tools registered with exact names and forward args to the service", async () => {
  const service = svc
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
