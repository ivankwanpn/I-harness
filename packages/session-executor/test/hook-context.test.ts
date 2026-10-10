import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionAssembly } from "../src/index.ts"
import type { LLMRequest, ModelClient } from "../../llm-seam/src/index.ts"

it("reads granted hook context dynamically in main and independent child requests without replacing host context", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-hook-context-"))
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) {
    requests.push(structuredClone(request))
    yield { type: "text/chunk", text: "done" }
    yield { type: "end" }
  } }
  let context = "REVIEWED_PLUGIN_CONTEXT"
  const assembly = await createSessionAssembly({ workspace: root, sessionId: "parent", model, approveAll: true,
    codeMode: { mode: "off" }, additionalSystemPrompt: () => "HOST_GOAL_CONTEXT",
    ...{ hookContext: () => context },
    pluginAgents: [{ name: "hook-reader", description: "Read the supplied task", systemPrompt: "CHILD_ROLE", tools: ["read"] }],
  })
  try {
    await assembly.agent.run("main")
    expect(requests.at(-1)!.systemPrompt).toContain("REVIEWED_PLUGIN_CONTEXT")
    expect(requests.at(-1)!.systemPrompt).toContain("HOST_GOAL_CONTEXT")
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "with_hook", agent_type: "hook-reader", message: "child", fork_turns: "none", background: false } })
    expect(requests.at(-1)!.systemPrompt).toContain("CHILD_ROLE")
    expect(requests.at(-1)!.systemPrompt).toContain("REVIEWED_PLUGIN_CONTEXT")
    context = ""
    await assembly.agent.run("after revoke")
    expect(requests.at(-1)!.systemPrompt).not.toContain("REVIEWED_PLUGIN_CONTEXT")
    expect(requests.at(-1)!.systemPrompt).toContain("HOST_GOAL_CONTEXT")
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "without_hook", agent_type: "hook-reader", message: "child", fork_turns: "none", background: false } })
    expect(requests.at(-1)!.systemPrompt).toContain("CHILD_ROLE")
    expect(requests.at(-1)!.systemPrompt).not.toContain("REVIEWED_PLUGIN_CONTEXT")
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}, 15_000)
