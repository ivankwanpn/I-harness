import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it, vi } from "vitest"
import type { LLMRequest, ModelClient } from "../../llm-seam/src/index.ts"
import { createSessionService } from "@i-harness/session-executor"
import { createSubagentSettings } from "../src/subagent-settings.ts"

it.each(["reviewer", "plugin-reviewer"] as const)("uses a real configured %s capability definition and its selected model", async role => {
  const root = await mkdtemp(join(tmpdir(), "ih-configured-role-")), settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, JSON.stringify({ plugins: { subagentModel: true }, agents: { roles: { [role]: { provider: "fixture", model: "child-model", protocol: "openai-responses" } } } }))
  const settings = createSubagentSettings(settingsPath, true)
  const requests: LLMRequest[] = [], resolved: unknown[] = []
  const child: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "Configured child reply" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", sandbox: "read-only", approveAll: true,
    codeMode: { mode: role === "reviewer" ? "mixed" : "off" },
    guardian: { execution: "isolated", enabled: () => false }, roleSelectionFor: settings.selectionFor, allowSubagentModelSelection: true,
    resolveRoleModel: async selection => { resolved.push(selection); return { status: "ready", binding: { client: child } } },
    ...(role === "plugin-reviewer" ? { pluginAgents: [{ name: role, description: "Configured analysis role", systemPrompt: "Review the assigned files", tools: ["read"] }] } : {}),
  })
  try {
    const assembly = await service.assemblyFor("parent")
    const prepared = await assembly.tools.prepare({ name: "spawn_agent", args: { task_name: "configured", agent_type: role, message: "Review this task" } }, undefined, { sessionId: "parent" })
    const spawned = await assembly.tools.dispatch(prepared) as { agent_path: string }
    await vi.waitFor(() => expect(assembly.subagentState().jobs.every(job => job.status !== "running")).toBe(true))
    expect(spawned.agent_path).toBe("root/configured")
    expect(resolved).toEqual([{ provider: "fixture", model: "child-model", protocol: "openai-responses" }])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(role === "reviewer" ? [] : ["read"])
    expect(assembly.subagentState().agentTable[0]?.modelLabel).toBe("fixture:child-model")
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it("a configured model alone cannot invent an unknown role's capabilities", async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", approveAll: true,
    roleSelectionFor: () => ({ provider: "fixture", model: "selected" }), allowSubagentModelSelection: true,
  })
  try {
    const assembly = await service.assemblyFor("parent")
    const prepared = await assembly.tools.prepare({ name: "spawn_agent", args: { task_name: "unknown", agent_type: "undeclared-capability", message: "Run" } }, undefined, { sessionId: "parent" })
    await expect(assembly.tools.dispatch(prepared)).rejects.toThrow(/unknown role.*capability definition/)
    expect(assembly.subagentState().agentTable).toEqual([])
    expect(assembly.subagentState().jobs).toEqual([])
  } finally { await service.close() }
})
