import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { runHeadless } from "../src/run.ts"

it.each(["mixed", "only"] as const)("runs a real CLI Code Mode cell in %s mode with a fixture model", async (mode) => {
  const workspace = await mkdtemp(join(tmpdir(), "ih-cli-code-"))
  const previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = workspace
  const session = createSession()
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(await tools.list_dir({path:"."}));' } } }
    else yield { type: "text/chunk", text: "program completed" }
    yield { type: "end" }
  } }
  try {
    const result = await runHeadless("list files", { workspace, session, model, sandbox: "danger-full-access", codeMode: { mode } })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toBe("program completed")
    expect(session.events.some(event => event.type === "code/dispatch")).toBe(true)
    const names = requests[0]!.tools.map(tool => tool.name)
    if (mode === "only") expect(names).toEqual(["code_exec", "code_wait"])
    else expect(names).toContain("list_dir")
    expect(requests[1]!.messages.filter(message => message.role === "tool")).toHaveLength(1)
  } finally {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    await rm(workspace, { recursive: true, force: true })
  }
})
