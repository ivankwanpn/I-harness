import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ open: vi.fn((_spec: unknown, _owner: unknown) => ({ id: "t", pid: 1 })), list: vi.fn(() => [] as unknown[]), read: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn(), dispose: vi.fn() }))
vi.mock("@i-harness/terminal", () => ({ createTerminalService: () => mock }))
import { createDesktopTerminal } from "../src/terminal.ts"
beforeEach(() => vi.clearAllMocks())
it("discovers installed shell profiles and opens only the selected profile", () => {
  mock.open.mockClear()
  const terminals = createDesktopTerminal("D:/agent-complete/playground", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\bin", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    exists: (path: string) => ["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "C:/Windows/System32/cmd.exe"].includes(path.replaceAll("\\", "/")),
  })
  const options = terminals.request("desktop/terminal/options", {}) as Array<{ id: string; command?: string }>
  expect(options.map((option) => option.id)).toContain("git-bash")
  expect(options.find((option) => option.id === "auto")?.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
  expect(options.find((option) => option.id === "git-bash")?.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
  terminals.request("desktop/terminal/open", { shell: "git-bash", command: "C:/untrusted.exe" })
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Program Files\\Git\\bin\\bash.exe", cwd: "D:/agent-complete/playground" }), { sessionId: "desktop-user" })
  expect(() => terminals.request("desktop/terminal/open", { shell: "arbitrary" })).toThrow(/shell/i)
  expect(() => terminals.request("desktop/terminal/open", { shell: "pwsh" })).toThrow(/unavailable/i)
  terminals.close()
})
it("automatically prefers Git Bash on Windows and falls back to CMD", () => {
  const installed = new Set(["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "C:/Windows/System32/cmd.exe"])
  const options = { platform: "win32" as const, env: { SystemRoot: "C:\\Windows", PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, exists: (path: string) => installed.has(path.replaceAll("\\", "/")) }
  const withGit = createDesktopTerminal("D:/workspace", options)
  withGit.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Program Files\\Git\\bin\\bash.exe" }), { sessionId: "desktop-user" })
  withGit.close()

  installed.delete("C:/Program Files/Git/bin/bash.exe")
  const withoutGit = createDesktopTerminal("D:/workspace", options)
  withoutGit.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "C:\\Windows\\System32\\cmd.exe" }), { sessionId: "desktop-user" })
  withoutGit.close()
})
it("uses the execution host's login shell on Unix and lists only detected alternatives", () => {
  const terminals = createDesktopTerminal("/workspace", {
    platform: "linux",
    env: { SHELL: "/bin/zsh", PATH: "/bin:/usr/bin" },
    exists: (path: string) => ["/bin/zsh", "/bin/sh", "/usr/bin/bash"].includes(path),
  })
  expect(terminals.request("desktop/terminal/options", {})).toEqual([
    { id: "auto", label: "自動選擇", command: "/bin/zsh" }, { id: "bash", label: "bash", command: "/usr/bin/bash" }, { id: "zsh", label: "zsh", command: "/bin/zsh" }, { id: "sh", label: "sh", command: "/bin/sh" },
  ])
  terminals.request("desktop/terminal/open", {})
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "/bin/zsh", cwd: "/workspace" }), { sessionId: "desktop-user" })
  terminals.close()
})
it("finds Git Bash beside a git.exe installed outside Program Files", () => {
  const terminals = createDesktopTerminal("D:/workspace", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "D:\\Tools\\Git\\cmd", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    exists: (path: string) => ["D:/Tools/Git/cmd/git.exe", "D:/Tools/Git/bin/bash.exe", "C:/Windows/System32/cmd.exe"].includes(path.replaceAll("\\", "/")),
  })
  expect(terminals.request("desktop/terminal/options", {})).toContainEqual({ id: "git-bash", label: "Git Bash", command: "D:\\Tools\\Git\\bin\\bash.exe" })
  terminals.close()
})
it("offers a real Bash on PATH while ignoring the Windows WSL launcher", () => {
  const terminals = createDesktopTerminal("D:/workspace", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;D:\\Tools\\Rtools\\usr\\bin" },
    exists: (path: string) => ["C:/Windows/System32/bash.exe", "D:/Tools/Rtools/usr/bin/bash.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"].includes(path.replaceAll("\\", "/")),
  })
  expect(terminals.request("desktop/terminal/options", {})).toContainEqual({ id: "bash", label: "Bash (PATH)", command: "D:\\Tools\\Rtools\\usr\\bin\\bash.exe" })
  terminals.request("desktop/terminal/open", { shell: "bash" })
  expect(mock.open).toHaveBeenLastCalledWith(expect.objectContaining({ command: "D:\\Tools\\Rtools\\usr\\bin\\bash.exe" }), { sessionId: "desktop-user" })
  terminals.close()
})
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
