// 延用 shell.test.ts 的 fakeExec 模式（L239 起）：retention 邏輯只需 exec.run 回傳完整結果。
import { describe, expect, it } from "vitest"
import { createShellTools } from "../src/index.ts"
import type { ExecService } from "@i-harness/exec"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function fakeExec(
  runResult: {
    stdout: string
    stderr: string
    exitCode: number
    stdoutSpillPath?: string
    stderrSpillPath?: string
    truncated?: { stdout: boolean; stderr: boolean }
  },
): ExecService {
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
  // Regression (M21 review Fix 1): 僅 stderr 截斷、stdout 未截斷時，不 spill、不加
  // notice——stdout 原樣保留（否則會出現未省略卻標記 "(Omitted 0 bytes…)" 的贅訊）。
  it("stderr-only truncation: no spill, no notice, stdout untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-shell-spill-stderr-"))
    const tools = createShellTools({
      exec: fakeExec({ stdout: "hi", stderr: "x".repeat(1000), exitCode: 0 }),
      retention: { maxBytes: 100, spill: { root } },
    })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as {
      stdout: string
      truncated?: { stdoutBytes: number; stderrBytes: number }
    }
    expect(res.truncated).toEqual({ stdoutBytes: 0, stderrBytes: 900 })
    expect(res.stdout).toBe("hi") // 未截斷 → 不加 notice、不動內容
    expect(res.stdout).not.toContain("stored at:")
    // 沒有任何 spill 檔被建立（root 仍為空）
    const files = await import("node:fs/promises").then((m) => m.readdir(root))
    expect(files).toEqual([])
  })
  // M21 review Fix 2: pwsh 的 spill 檔用 per-tool 前綴 "pwsh-stdout-"。
  it("pwsh spill file uses pwsh-stdout- prefix", async () => {
    const big = "x".repeat(1000)
    const root = mkdtempSync(join(tmpdir(), "i-harness-shell-spill-pwsh-"))
    const tools = createShellTools({
      exec: fakeExec({ stdout: big, stderr: "", exitCode: 0 }),
      retention: { maxBytes: 100, spill: { root } },
    })
    const pwsh = tools.find((t) => t.name === "pwsh")!
    await pwsh.execute({ command: "Get-Date" }, {} as never)
    const files = await import("node:fs/promises").then((m) => m.readdir(root))
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.startsWith("pwsh-stdout-"))).toBe(true)
  })
  // Regression (M21 final-review Fix 1): A/B double-truncation bridge —— exec 層
  // 已 spill（stdout 僅回 tail）而 retainer 看 tail 未超預算 → retainer 自身判
  // truncated:false。若不橋接 exec 的截斷狀態，A(spill)+B(retention) 同開會静默
  // 截斷、無 notice。修後必須：truncated 標記存在、notice 指向「既有的」exec
  // spill 檔（且不重複寫一份 shell spill——本測試未設定 shell store，root 無檔）。
  it("exec spill + tail within retention budget → truncated:true, notice points at exec spill path", async () => {
    const execSpillPath = join(tmpdir(), "i-harness-exec-spill-x.log") // 僅作字串引用，不被觸碰
    const tools = createShellTools({
      exec: fakeExec({
        stdout: "tail-tail", // exec 已把完整輸出落檔，記憶體僅剩 tail（很小）
        stderr: "",
        exitCode: 0,
        stdoutSpillPath: execSpillPath,
        truncated: { stdout: true, stderr: false },
      }),
      retention: { maxBytes: 64_000 }, // 預算大 → retainer 自身不會判截斷
    })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as {
      stdout: string
      truncated?: { stdoutBytes: number; stderrBytes: number }
    }
    expect(res.truncated).toBeDefined() // 不得被 retainer 吞掉（原本為 undefined）
    expect(res.stdout).toContain("(Omitted")
    expect(res.stdout).toContain(execSpillPath) // notice 引用既有 exec spill 檔
    expect(res.stdout).toContain("tail-tail") // tail 本身保留在 retained 輸出中
  })
})
