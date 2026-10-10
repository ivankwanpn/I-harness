import { expect, it } from "vitest"
import { existsSync } from "node:fs"
import { win32 } from "node:path"
import { createExecService } from "@i-harness/exec"
import { createTerminalService } from "../src/service.ts"

const bash = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
async function until(check: () => boolean, detail: () => string = () => "") {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`PTY acknowledgement timed out: ${JSON.stringify(detail().slice(-6000))}`)
}
it.skipIf(process.platform !== "win32" || !existsSync(bash))("delivers the complete first command and dimensions after mixed terminal resizes", async () => {
  const exec = createExecService(), terminal = createTerminalService(exec)
  try {
    const opened = await terminal.open({ command: bash, args: ["--noprofile", "--norc", "-i"], cols: 100, rows: 24,
      env: { ...process.env, PS1: "IH_PTY_READY> ", TERM: "xterm-256color" } as Record<string, string> })
    await until(() => terminal.read(opened.id).data.includes("IH_PTY_READY>"))
    const sizes = [[143, 37], [91, 22], [145, 39], [93, 24], [120, 30], [80, 20], [160, 40], [100, 25]] as const
    for (const [index, [cols, rows]] of sizes.entries()) {
      await terminal.resize(opened.id, cols, rows)
      const offset = terminal.read(opened.id).nextOffset
      // Split the expected marker so terminal input echo cannot satisfy the assertion.
      await terminal.send(opened.id, `echo "IH_RESIZE_${index}_"OK; tput cols; tput lines\r`)
      await until(() => terminal.read(opened.id, { offset }).data.includes(`IH_RESIZE_${index}_OK`), () => terminal.read(opened.id, { offset }).data)
      const dimensions = new RegExp(`(?:^|\\r?\\n)${cols}\\r?\\n${rows}(?:\\r?\\n|$)`)
      // SIGWINCH can redraw PS1 before the command output reaches the reader.
      await until(() => dimensions.test(terminal.read(opened.id, { offset }).data), () => terminal.read(opened.id, { offset }).data)
      await until(() => terminal.read(opened.id, { offset }).data.includes("IH_PTY_READY>"))
      const output = terminal.read(opened.id, { offset }).data
      expect(output).not.toContain("cho: command not found")
      expect(output).toMatch(dimensions)
    }
  } finally { await terminal.dispose(); await exec.dispose() }
}, 45_000)
