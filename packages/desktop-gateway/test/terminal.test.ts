import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ open: vi.fn((_spec: unknown, _owner: unknown) => ({ id: "t", pid: 1 })), list: vi.fn(() => [] as unknown[]), read: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn(), dispose: vi.fn(), disposeExec: vi.fn(async () => {}), createExec: vi.fn((_opts: unknown) => ({ dispose: mock.disposeExec })) }))
vi.mock("@i-harness/terminal", () => ({ createTerminalService: () => mock }))
vi.mock("@i-harness/exec", () => ({ createExecService: mock.createExec, withExecCallerScope: (_owner: unknown, call: () => unknown) => call() }))
import { createDesktopTerminal } from "../src/terminal.ts"
beforeEach(() => {
  vi.clearAllMocks()
  mock.open.mockImplementation((_spec, _owner) => ({ id: "t", pid: 1 }))
  mock.list.mockImplementation(() => [])
  mock.dispose.mockImplementation(() => undefined)
})
it("discovers installed shell profiles and opens only the selected profile", async () => {
  mock.open.mockClear()
  const terminals = createDesktopTerminal("D:/agent-complete/playground", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\bin", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    exists: (path: string) => ["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "C:/Windows/System32/cmd.exe"].includes(path.replaceAll("\\", "/")),
  })
  expect(mock.createExec).toHaveBeenCalledWith({ workspaceRoot: "D:/agent-complete/playground", standaloneOwner: { sessionId: "desktop-user" } })
  const options = await terminals.request("desktop/terminal/options", {}) as Array<{ id: string; command?: string }>
  expect(options.map((option) => option.id)).toContain("git-bash")
  expect(options.find((option) => option.id === "auto")?.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
  expect(options.find((option) => option.id === "git-bash")?.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
  await terminals.request("desktop/terminal/open", { shell: "git-bash", command: "C:/untrusted.exe" })
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Program Files\\Git\\bin\\bash.exe", cwd: "D:/agent-complete/playground" }), { sessionId: "desktop-user" })
  await expect(terminals.request("desktop/terminal/open", { shell: "arbitrary" })).rejects.toThrow(/shell/i)
  await expect(terminals.request("desktop/terminal/open", { shell: "pwsh" })).rejects.toThrow(/unavailable/i)
  await terminals.close()
})
it("automatically prefers Git Bash on Windows and falls back to CMD", async () => {
  const installed = new Set(["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "C:/Windows/System32/cmd.exe"])
  const options = { platform: "win32" as const, env: { SystemRoot: "C:\\Windows", PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, exists: (path: string) => installed.has(path.replaceAll("\\", "/")) }
  const withGit = createDesktopTerminal("D:/workspace", options)
  await withGit.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Program Files\\Git\\bin\\bash.exe" }), { sessionId: "desktop-user" })
  await withGit.close()

  installed.delete("C:/Program Files/Git/bin/bash.exe")
  const withoutGit = createDesktopTerminal("D:/workspace", options)
  await withoutGit.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Windows\\System32\\cmd.exe" }), { sessionId: "desktop-user" })
  await withoutGit.close()
})
it("uses the execution host's login shell on Unix and lists only detected alternatives", async () => {
  const terminals = createDesktopTerminal("/workspace", {
    platform: "linux",
    env: { SHELL: "/bin/zsh", PATH: "/bin:/usr/bin" },
    exists: (path: string) => ["/bin/zsh", "/bin/sh", "/usr/bin/bash"].includes(path),
  })
  expect(await terminals.request("desktop/terminal/options", {})).toEqual([
    { id: "auto", label: "自動選擇", command: "/bin/zsh" }, { id: "bash", label: "bash", command: "/usr/bin/bash" }, { id: "zsh", label: "zsh", command: "/bin/zsh" }, { id: "sh", label: "sh", command: "/bin/sh" },
  ])
  await terminals.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "/bin/zsh", cwd: "/workspace" }), { sessionId: "desktop-user" })
  await terminals.close()
})
it("finds Git Bash beside a git.exe installed outside Program Files", async () => {
  const terminals = createDesktopTerminal("D:/workspace", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "D:\\Tools\\Git\\cmd", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    exists: (path: string) => ["D:/Tools/Git/cmd/git.exe", "D:/Tools/Git/bin/bash.exe", "C:/Windows/System32/cmd.exe"].includes(path.replaceAll("\\", "/")),
  })
  expect(await terminals.request("desktop/terminal/options", {})).toContainEqual({ id: "git-bash", label: "Git Bash", command: "D:\\Tools\\Git\\bin\\bash.exe" })
  await terminals.close()
})
it("offers a real Bash on PATH while ignoring the Windows WSL launcher", async () => {
  const terminals = createDesktopTerminal("D:/workspace", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;D:\\Tools\\Rtools\\usr\\bin" },
    exists: (path: string) => ["C:/Windows/System32/bash.exe", "D:/Tools/Rtools/usr/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"].includes(path.replaceAll("\\", "/")),
  })
  expect(await terminals.request("desktop/terminal/options", {})).toContainEqual({ id: "bash", label: "Bash (PATH)", command: "D:\\Tools\\Rtools\\usr\\bin\\bash.exe" })
  await terminals.request("desktop/terminal/open", { shell: "bash" })
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "D:\\Tools\\Rtools\\usr\\bin\\bash.exe" }), { sessionId: "desktop-user" })
  await terminals.close()
})
it("owns a fixed workspace shell and bounds terminal parameters", async () => {
  const terminals = createDesktopTerminal("D:/agent-complete/playground")
  await terminals.request("desktop/terminal/open", { cwd: "outside", command: "untrusted", cols: 80, rows: 24 })
  expect(mock.open).toHaveBeenCalledWith(expect.objectContaining({ cwd: "D:/agent-complete/playground", rawOutput: true, cols: 80, rows: 24 }), { sessionId: "desktop-user" })
  expect(mock.open.mock.calls[0]?.[0]).not.toMatchObject({ command: "untrusted" })
  await expect(terminals.request("desktop/terminal/resize", { id: "t", cols: 0, rows: 24 })).rejects.toThrow()
  await expect(terminals.request("desktop/terminal/write", { id: "t", data: "a".repeat(32769) })).rejects.toThrow()
  await terminals.request("desktop/terminal/read", { id: "t", offset: 50 })
  expect(mock.read).toHaveBeenCalledWith("t", { sessionId: "desktop-user", offset: 50, maxBytes: 32768 })
  await terminals.close()
  expect(mock.dispose).toHaveBeenCalledOnce()
  await expect(terminals.request("desktop/terminal/list", {})).rejects.toThrow("closed")
})

it("reports incomplete human terminal cleanup and retries before disposing its exec owner", async () => {
  const terminals = createDesktopTerminal("D:/workspace")
  mock.dispose.mockRejectedValueOnce(new Error("native tree cleanup incomplete"))
  await expect(terminals.close()).rejects.toThrow(/incomplete/)
  expect(mock.disposeExec).not.toHaveBeenCalled()
  expect(await terminals.request("desktop/terminal/list", {})).toEqual([])
  await terminals.close()
  expect(mock.dispose).toHaveBeenCalledTimes(2)
  expect(mock.disposeExec).toHaveBeenCalledOnce()
  await expect(terminals.request("desktop/terminal/list", {})).rejects.toThrow("closed")
})

it("reserves all eight slots while opens are still awaiting native admission", async () => {
  const gates = Array.from({ length: 9 }, () => Promise.withResolvers<{ id: string; pid: number }>())
  let next = 0
  mock.open.mockImplementation(() => gates[next++]!.promise as never)
  const terminals = createDesktopTerminal("D:/workspace")
  const pending = Array.from({ length: 8 }, () => terminals.request("desktop/terminal/open", { shell: "auto" }))
  const ninth = terminals.request("desktop/terminal/open", { shell: "auto" })
  const started = mock.open.mock.calls.length
  gates.forEach((gate, index) => gate.resolve({ id: `t-${index}`, pid: index + 1 }))
  await Promise.allSettled([...pending, ninth])
  await terminals.close()
  expect(started).toBe(8)
})

it("keeps a capacity slot when a failed open has unresolved native cleanup", async () => {
  const committed: unknown[] = []
  let launches = 0
  mock.list.mockImplementation(() => committed)
  mock.open.mockImplementation(() => {
    launches++
    if (launches === 8) return Promise.reject(new Error("native cleanup incomplete")) as never
    const view = { id: `t-${launches}`, pid: launches }
    committed.push(view)
    return Promise.resolve(view) as never
  })
  const terminals = createDesktopTerminal("D:/workspace")
  for (let index = 0; index < 7; index++) await terminals.request("desktop/terminal/open", {})
  await expect(terminals.request("desktop/terminal/open", {})).rejects.toThrow(/incomplete/)
  const ninth = terminals.request("desktop/terminal/open", {})
  const started = launches
  await Promise.allSettled([ninth])
  await terminals.close()
  expect(started).toBe(8)
})

it("releases a reserved slot after a completed admission refusal", async () => {
  let launches = 0
  const gates = Array.from({ length: 8 }, () => Promise.withResolvers<{ id: string; pid: number }>())
  mock.open.mockImplementation(() => {
    launches++
    if (launches === 1) return Promise.reject(new Error("executable unavailable")) as never
    return gates[launches - 2]!.promise as never
  })
  const terminals = createDesktopTerminal("D:/workspace")
  await expect(terminals.request("desktop/terminal/open", {})).rejects.toThrow(/unavailable/)
  const pending = Array.from({ length: 8 }, () => terminals.request("desktop/terminal/open", {}))
  const ninth = terminals.request("desktop/terminal/open", {})
  const started = launches
  gates.forEach((gate, index) => gate.resolve({ id: `t-${index}`, pid: index + 1 }))
  await Promise.allSettled([...pending, ninth])
  expect(started).toBe(9)
  await terminals.close()
})
