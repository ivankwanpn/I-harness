import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runHeadless } from "../src/run.ts"
import { main } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { registerApprovalAnswerer } from "@i-harness/interaction"

describe("headless CLI (M2)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-m2-"))
    writeFileSync(join(dir, "data.txt"), "old line")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs read→write→report through the full pipeline (fs tools + guard)", async () => {
    const result = await runHeadless("edit data.txt", {
      workspace: dir,
      approveAll: true, // guard-approval ask is auto-approved in headless mode
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "write", args: { path: "data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已修改" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("报告")
    expect(readFileSync(join(dir, "data.txt"), "utf-8")).toBe("hello")
  })

  it("denies a dangerous command without approval (guard-approval active)", async () => {
    const result = await runHeadless("run dangerous", {
      workspace: dir,
      approveAll: false, // no approval → fail closed
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf data.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })

  it("returns non-zero exit code on a tool error", async () => {
    const result = await runHeadless("read missing", {
      workspace: dir,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "nope.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })

  it("cross-scope: parent policy gates a child-scope registry dispatch (fail closed)", async () => {
    // parent ctx mounts the approval policy + a shell tool registry
    const parentCtx = createContext()
    const parentTools = createToolRegistry(parentCtx)
    createApprovalPolicy(parentCtx, parentTools, { workspace: dir })
    parentTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    // child scope registers its OWN registry + bash-like write tool
    const childCtx = parentCtx.scope.mount()
    const childTools = createToolRegistry(childCtx)
    let bodyRan = false
    childTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => {
        bodyRan = true
        return { stdout: "ran", exitCode: 0 }
      },
    })

    // dispatch through the CHILD registry with NO answerer anywhere
    await expect(childTools.execute({ name: "bash", args: { command: "rm -rf data.txt" } })).rejects.toThrow(/approval|denied/i)
    expect(bodyRan).toBe(false)
  })

  it("cross-scope negative control: parent answerer auto-approves a child dispatch", async () => {
    const parentCtx = createContext()
    const parentTools = createToolRegistry(parentCtx)
    createApprovalPolicy(parentCtx, parentTools, { workspace: dir })
    registerApprovalAnswerer(parentCtx, async () => ({ approved: true }))
    parentTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    const childCtx = parentCtx.scope.mount()
    const childTools = createToolRegistry(childCtx)
    childTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    // the parent answerer (inherited via the service chain) must approve the
    // dangerous child dispatch — proving the gate is the policy, not a broken
    // dispatch path
    const result = await childTools.execute({ name: "bash", args: { command: "rm -rf data.txt" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })
})

describe("CLI main + entry guard", () => {
  it("main() prints the final text and returns 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello"])
      expect(code).toBe(0)
      expect(log).toHaveBeenCalledWith("ok")
    } finally {
      log.mockRestore()
    }
  })

  it("runs main when the CLI module is executed as the entry point", () => {
    // spawn a real node process so the module-level entry guard fires:
    // `node --import tsx apps/cli/src/index.ts run "hello"` must print and exit 0.
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url))
    const res = spawnSync(process.execPath, ["--import", "tsx", entry, "run", "hello"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("ok")
  })
})
