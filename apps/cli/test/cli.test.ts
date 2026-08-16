import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"

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
})
