// e2e/workflow.e2e.ts — M25 §2.1: the REAL workflow engine (M24b mount) running
// a REAL step subprocess (node on PATH — Windows-safe, tokenized, no shell
// syntax), observed through job_output.
//
// Tool-driving goes through runHeadless + mockScript (see team.e2e.ts for the
// mock-injection ruling).
import { describe, expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { makeWorkspace, removeWorkspace } from "./helpers.ts"

describe("e2e workflow", () => {
  it("workflow_run executes a real step subprocess; job_output observes completion", async () => {
    const dir = makeWorkspace("i-harness-e2e-wf-")
    try {
      mkdirSync(join(dir, "workflow"))
      writeFileSync(
        join(dir, "workflow", "hello.yml"),
        [
          "name: hello",
          "description: Print a greeting then finish.",
          "steps:",
          "  - name: greet",
          `    command: node -e "console.log('wf hello from step')"`,
        ].join("\n"),
        "utf8",
      )
      const result = await runHeadless("run the hello workflow", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "workflow_list", args: {} }] },
          { role: "assistant", toolCalls: [{ name: "workflow_run", args: { name: "hello" } }] },
          { role: "assistant", toolCalls: [{ name: "job_output", args: { job_id: "workflow-1", wait: true, timeout_ms: 10_000 } }] },
          { role: "assistant", text: "workflow finished" },
        ],
      })
      expect(result.exitCode, result.error).toBe(0)
      const results = result.session?.events.filter((e) => e.type === "tool/result") as { name: string; output: unknown }[]
      // The real workflow/*.yml sample was scanned into the definitions registry.
      const list = results.find((e) => e.name === "workflow_list")
      expect(JSON.stringify(list?.output)).toContain("hello")
      // workflow_run returned the single-job id for the run.
      const run = results.find((e) => e.name === "workflow_run")
      expect(JSON.stringify(run?.output)).toContain("workflow-1")
      // job_output collected the REAL subprocess stdout + progress + final status.
      const out = results.find((e) => e.name === "job_output")
      const outJson = JSON.stringify(out?.output)
      expect(outJson).toContain("wf hello from step")
      expect(outJson).toContain("[step 1/1 greet] ok")
      expect(outJson).toContain("[status: completed]")
    } finally {
      removeWorkspace(dir)
    }
  }, 60_000)
})
