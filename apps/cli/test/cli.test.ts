import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runHeadless } from "../src/run.ts"
import { main } from "../src/index.ts"

describe("headless CLI", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-"))
    writeFileSync(join(dir, "data.txt"), "old line")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs the read → edit → report acceptance task", async () => {
    const result = await runHeadless("把 data.txt 第一行改成 hello", {
      workspace: dir,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "edit", args: { path: "data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已将 data.txt 第一行改为 hello" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("hello")
    expect(readFileSync(join(dir, "data.txt"), "utf-8")).toBe("hello")
  })

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
