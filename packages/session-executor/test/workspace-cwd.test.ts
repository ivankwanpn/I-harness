// D1 (m55-shell): every exec-spawning tool mounted by the assembly must run in
// the ASSEMBLY workspace, never the process cwd. RED before the fix: the bash
// tool's `pwd` printed the vitest cwd, the PTY spawned in the vitest cwd and
// `glob` with no path searched the vitest cwd — while the fs tools resolved
// against the workspace.
import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecService, type ExecService } from "@i-harness/exec"
import type { TerminalService } from "@i-harness/terminal"
import { resolveRgPath } from "@i-harness/fs-search"
import { createSessionAssembly } from "../src/assembly.ts"
import { rmWorkspaceSync } from "./helpers.ts"

const fwd = (p: string): string => p.replace(/\\/g, "/")

// `pwd -W` prints the Windows (drive-letter) form on Git Bash/MSYS so the
// assertion compares like with like against mkdtempSync's native path; POSIX
// bash prints the same form as Node's tmpdir already.
const PWD_CMD = process.platform === "win32" ? "pwd -W" : "pwd"

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met")
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Strip CSI/OSC escape sequences (ConPTY init + title) so PTY output can be
 * compared as text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
}

async function pwshAvailable(): Promise<boolean> {
  const r = await createExecService().run({
    argv: ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PWD.Path"],
  })
  return r.exitCode === 0
}

async function rgAvailable(): Promise<boolean> {
  try { await resolveRgPath(); return true } catch { return false }
}

type ToolResultEvent = { type: "tool/result"; callId: string; name: string; output: unknown }

function toolResults(assembly: Awaited<ReturnType<typeof createSessionAssembly>>): ToolResultEvent[] {
  return assembly.session.events.filter((e): e is ToolResultEvent => e.type === "tool/result")
}

describe("D1: assembly tools run in the assembly workspace", () => {
  it("bash `pwd` prints the assembly workspace, not the process cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-cwd-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: PWD_CMD } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "bash")!
      const output = result.output as { stdout?: string; exitCode?: number }
      expect(output.exitCode).toBe(0)
      expect(fwd((output.stdout ?? "").trim())).toBe(fwd(workspace))
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)

  it("bash background jobs also run in the assembly workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-bg-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: PWD_CMD, background: true } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "bash")!
      const jobId = (result.output as { job_id?: string }).job_id!
      const exec = assembly.ctx.services.get<ExecService>("exec/service")
      await waitFor(() => exec.getOutput(jobId).status !== "running")
      const job = exec.getOutput(jobId)
      expect(job.exitCode).toBe(0)
      expect(fwd(job.stdout.trim())).toBe(fwd(workspace))
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)

  it("pwsh `pwd` prints the assembly workspace (skipped when pwsh is absent)", async () => {
    if (!(await pwshAvailable())) return
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-pwsh-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "pwsh", args: { command: "$PWD.Path" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "pwsh")!
      const output = result.output as { stdout?: string; exitCode?: number }
      expect(output.exitCode).toBe(0)
      expect(fwd((output.stdout ?? "").trim())).toBe(fwd(workspace))
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)

  it("terminal_open spawns the PTY in the assembly workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-pty-"))
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        {
          role: "assistant",
          toolCalls: [{
            name: "terminal_open",
            args: { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cols: 500, rows: 24 },
          }],
        },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "terminal_open")!
      const id = (result.output as { id: string }).id
      const terminals = assembly.ctx.services.get<TerminalService>("terminal/service")
      await waitFor(() => stripAnsi(terminals.read(id, { sessionId: "s1" }).data).trim().length > 0)
      const data = stripAnsi(terminals.read(id, { sessionId: "s1" }).data)
      expect(fwd(data.trim())).toBe(fwd(workspace))
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)

  it("workflow_run steps without cwd run in the assembly workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-wf-"))
    mkdirSync(join(workspace, "workflow"), { recursive: true })
    // The step command is tokenized (no shell), so spawn node directly with a
    // script that prints its cwd. Forward slashes: getArgv eats backslashes.
    const nodePath = process.execPath.replace(/\\/g, "/")
    writeFileSync(
      join(workspace, "workflow", "cwd-probe.yml"),
      [
        "name: cwd-probe",
        "description: print the step cwd",
        "steps:",
        "  - name: pwd",
        `    command: '"${nodePath}" -e process.stdout.write(process.cwd())'`,
        "",
      ].join("\n"),
    )
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "workflow_run", args: { name: "cwd-probe", wait: true } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "workflow_run")!
      const output = result.output as { output?: string; status?: string }
      expect(output.status).toBe("completed")
      expect(fwd(output.output ?? "")).toContain(fwd(workspace))
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)

  it("glob with no path searches the assembly workspace (skipped without ripgrep)", async () => {
    if (!(await rgAvailable())) return
    const workspace = mkdtempSync(join(tmpdir(), "ih-ws-glob-"))
    writeFileSync(join(workspace, "marker.txt"), "marker\n")
    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "s1",
      approveAll: true,
      modelPolicy: "test-mock",
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "glob", args: { pattern: "**/*.txt" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    try {
      await assembly.agent.run("go")
      const result = toolResults(assembly).find((r) => r.name === "glob")!
      const output = result.output as { matches?: string[]; error?: string }
      expect(output.error).toBeUndefined()
      expect(output.matches).toContain("marker.txt")
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(workspace)
    }
  }, 30_000)
})
