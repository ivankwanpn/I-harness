import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createRoleRegistry } from "@i-harness/subagent"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createLoopbackProvider } from "../../core-agent/test/helpers/provider-loopback.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { acquireManagedExecution } from "../../session-persistence/src/execution-internal.ts"
import { createManagedExecutionRuntime } from "../src/managed-assembly.ts"
import { createOwnedPluginCatalog } from "../src/owned-plugin-catalog.ts"
import { mountOwnedSkillMentions } from "../src/owned-skill-mentions.ts"
import { createOwnedPluginMount } from "../../desktop-gateway/src/owned-plugin-mount.ts"

const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: "skill-call", function: { name: "skill_get", arguments: '{"name":"helper"}' } }] } : { content: "done" }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

it("expands the real command and carries skill mention, tool result, and continuation through the managed lane", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-causal-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const server = await createLoopbackProvider("/v1/chat/completions", [async res => { res.end(wire(true)) }, async res => { res.end(wire(false)) }])
  try {
    await coordinator.create({ sessionId: "main" })
    const dir = join(root, "skills", "helper"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), "---\nname: helper\ndescription: helps\n---\nreal skill body\n")
    const execution = await acquireManagedExecution(coordinator, "main")
    const runtime = createManagedExecutionRuntime({ execution, model: createOpenAICompatibleClient({ apiKey: "loopback", model: "fixture", baseUrl: server.baseUrl }), systemPrompt: "original", tools: [], contextWindow: 4096, maxOutputTokens: 128 })
    const catalog = createOwnedPluginCatalog({ ctx: runtime.ctx, tools: runtime.tools, roles: createRoleRegistry(), workspace: root, globalSkillDir: join(root, "global"), report: () => {} })
    const mentions = mountOwnedSkillMentions({ ctx: runtime.ctx, execution, domain: runtime.domain, registry: catalog.skillsRegistry })
    const plugin = createOwnedPluginMount({ ctx: runtime.ctx, sessionId: "main", startSource: "startup", configDir: root, workspace: root, report: () => {}, catalog })
    try {
      await plugin.update({ skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [], commandDescriptors: [{ name: "ask", body: "use $helper for $ARGUMENTS" }] })
      const input = await plugin.expand("/ask work")
      const submit = runtime.lane.submit({ tier: "send", text: input }); await submit.admitted; await runtime.lane.drain()
      expect(server.requests).toHaveLength(2)
      expect(JSON.stringify(server.requests[0]!.body.messages)).toContain('[skill mention]')
      expect(JSON.stringify(server.requests[1]!.body.messages)).toContain('real skill body')
      const events = (await backend.read("main")).events
      expect(events.some(event => event.type === "tool/result")).toBe(true)
      expect(events.some(event => event.type === "assistant/message" && JSON.stringify(event).includes("done"))).toBe(true)
    } finally { await mentions.close(); await plugin.close(); await runtime.close(); await execution.close() }
  } finally { await coordinator.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
