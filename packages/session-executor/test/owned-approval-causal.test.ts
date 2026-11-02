import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { onExecutionEvent } from "@i-harness/core-plugin"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createLoopbackProvider } from "../../core-agent/test/helpers/provider-loopback.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { acquireManagedExecution } from "../../session-persistence/src/execution-internal.ts"
import { createManagedExecutionRuntime } from "../src/managed-assembly.ts"
import { createApprovalRulesAdapter } from "../../desktop-gateway/src/approval-rules.ts"
import { createInteractionBridge } from "../../desktop-gateway/src/interaction.ts"

const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: "probe-call", function: { name: "probe", arguments: '{"value":"actual"}' } }] } : { content: "done" }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

it("routes a managed tool approval through the real owned bridge before body and continuation", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "approval-causal-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const server = await createLoopbackProvider("/v1/chat/completions", [async res => { res.end(wire(true)) }, async res => { res.end(wire(false)) }])
  try {
    await coordinator.create({ sessionId: "main" })
    const execution = await acquireManagedExecution(coordinator, "main"); let effects = 0
    const runtime = createManagedExecutionRuntime({ execution, model: createOpenAICompatibleClient({ apiKey: "loopback", model: "fixture", baseUrl: server.baseUrl }), systemPrompt: "original", tools: [{ name: "probe", description: "fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, approvalIdentity: () => ({ binding: "fixture" }), async execute(args) { effects++; return `actual result ${(args as { value: string }).value}` } }], contextWindow: 4096, maxOutputTokens: 128 })
    const rules = createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: () => undefined, ownedPolicyIdentity: () => ({ workspaceId: "w", revision: "r" }) })
    const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    onExecutionEvent(runtime.ctx, "tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
    bridge.attachOwned({ ctx: runtime.ctx, sessionId: runtime.domain.sessionId, tools: runtime.tools })
    try {
      const submit = runtime.lane.submit({ tier: "send", text: "run probe" }); await submit.admitted
      const draining = runtime.lane.drain()
      for (let i = 0; i < 1500 && !bridge.pending("main").length; i++) await new Promise(resolve => setTimeout(resolve, 10))
      const row = bridge.pending("main")[0]; expect(row).toBeDefined(); expect(effects).toBe(0)
      bridge.replyTrustedHuman({ requestId: row!.requestId, sessionId: "main", decision: { kind: "approval", approved: true, remember: { scope: "session", expiresAt: Date.now() + 60000 } } })
      await draining
      expect(effects).toBe(1); expect(rules.list("w")).toHaveLength(1)
      expect(JSON.stringify(server.requests[1]!.body.messages)).toContain("actual result actual")
      expect((await backend.read("main")).events.some(event => event.type === "tool/result")).toBe(true)
    } finally { bridge.close(); await runtime.close(); await execution.close() }
  } finally { await coordinator.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
