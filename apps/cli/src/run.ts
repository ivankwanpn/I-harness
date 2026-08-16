import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
}

export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const ctx: PluginContext = createContext()
  const session = createSession()
  const tools = createToolRegistry(ctx)

  // real file tools for the acceptance task
  const readTool: Tool<{ path: string }, { content: string }> = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async ({ path }) => {
      const fs = await import("node:fs/promises")
      const full = `${opts.workspace}/${path}`
      return { content: await fs.readFile(full, "utf-8") }
    },
  }
  const editTool: Tool<{ path: string; text: string }, { ok: boolean }> = {
    name: "edit",
    description: "write a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, text: { type: "string" } },
      required: ["path", "text"],
    },
    execute: async ({ path, text }) => {
      const fs = await import("node:fs/promises")
      const full = `${opts.workspace}/${path}`
      await fs.writeFile(full, text, "utf-8")
      return { ok: true }
    },
  }
  tools.register(readTool)
  tools.register(editTool)

  const model = createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
  const result = await agent.run(task)
  return { finalText: result.finalText, exitCode: 0 }
}
