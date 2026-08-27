// 延用 shell.test.ts 的 fakeExec 模式（L239 起）：retention 邏輯只需 exec.run 回傳完整結果。
import { describe, expect, it } from "vitest"
import { createShellTools } from "../src/index.ts"
import type { ExecService } from "@i-harness/exec"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function fakeExec(runResult: { stdout: string; stderr: string; exitCode: number }): ExecService {
  return {
    run: async () => ({ ...runResult, timedOut: false }),
    runBackground: () => ({ jobId: "none" }),
    getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }
}

describe("shell spill notice", () => {
  it("truncated result appends notice and spills full stdout", async () => {
    const big = "x".repeat(1000)
    const root = mkdtempSync(join(tmpdir(), "i-harness-shell-spill-"))
    const tools = createShellTools({
      exec: fakeExec({ stdout: big, stderr: "", exitCode: 0 }),
      retention: { maxBytes: 100, spill: { root } },
    })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as {
      stdout: string
      truncated: { stdoutBytes: number; stderrBytes: number }
    }
    expect(res.truncated).toEqual({ stdoutBytes: 900, stderrBytes: 0 })
    expect(res.stdout).toContain("(Omitted 900 bytes. Full result stored at:")
    // spill 檔存在於 root（內容正確性由 output-retention unit 測）
    const files = await import("node:fs/promises").then((m) => m.readdir(root))
    expect(files.some((f) => f.startsWith("bash-stdout-"))).toBe(true)
    // 且 spill 檔的 path 與 notice 內嵌的路徑一致（round-trip：檔案內容 = 完整原輸出）
    const file = files.find((f) => f.startsWith("bash-stdout-"))!
    const spillPath = join(root, file)
    expect(res.stdout).toContain(spillPath)
    expect(readFileSync(spillPath, "utf-8")).toBe(big)
  })
  it("no spill config → today's behavior (no notice)", async () => {
    const big = "x".repeat(1000)
    const tools = createShellTools({ exec: fakeExec({ stdout: big, stderr: "", exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string }
    expect(res.stdout).not.toContain("stored at:")
  })
})
