import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { builtinRoles } from "@i-harness/subagent"
import { createSessionAssembly } from "../src/assembly.ts"

const customRole = {
  name: "protocol-scout",
  description: "Maps protocol edges for an audit.",
  systemPrompt: "Map protocol edges.",
  tools: ["read"],
}

function captureModel(requests: LLMRequest[]): ModelClient {
  return { async *stream(request) {
    requests.push(request)
    yield { type: "text/chunk", text: "ok" }
    yield { type: "end" }
  } }
}

it("sends live role choices in actual direct parent requests and keeps unchanged metadata stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-direct-"))
  const requests: LLMRequest[] = []
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(requests), sandbox: "danger-full-access", codeMode: { mode: "off" },
    guardian: { execution: "isolated", enabled: () => false }, pluginAgents: [customRole],
    roleSelectionFor: name => name === "settings-only" ? { provider: "unused", model: "unused" } : undefined,
  })
  try {
    const ask = async () => {
      await assembly.agent.run("Choose a role for this task")
      return requests.at(-1)!.tools.find(tool => tool.name === "spawn_agent")!
    }
    const first = await ask()
    expect(first.description).toContain("explore")
    expect(first.description).toContain("research")
    expect(first.description).toContain("worker")
    expect(first.description).toContain("general")
    expect(first.description).toContain("protocol-scout: Maps protocol edges for an audit.")
    expect(first.description).toMatch(/reviewer.*approval guardian/i)
    expect(first.description).not.toContain("settings-only")
    expect(JSON.stringify(first.inputSchema)).toMatch(/agent_type.*exact.*role/i)
    expect(JSON.stringify(await ask())).toBe(JSON.stringify(first))

    await assembly.updatePluginCapabilities({})
    expect((await ask()).description).not.toContain("protocol-scout")
    await assembly.updatePluginCapabilities({ pluginAgents: [customRole] })
    expect(JSON.stringify(await ask())).toBe(JSON.stringify(first))
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("keeps role choice visible in a full Code Mode only parent request and its live search catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-code-"))
  const requests: LLMRequest[] = []
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(requests), sandbox: "danger-full-access", codeMode: { mode: "only" }, pluginAgents: [customRole] })
  try {
    await assembly.agent.run("Choose a subagent role")
    expect(requests.at(-1)!.tools.map(tool => tool.name)).toEqual(["code_exec", "code_status", "code_wait"])
    const description = requests.at(-1)!.tools[0]!.description
    expect(description).toContain("spawn_agent")
    expect(description).toContain("protocol-scout")
    expect(description).toMatch(/explore.*worker/s)
    const inspect = async () => {
      const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'text({hits:searchTools("protocol-scout",20), detail:describeTool("spawn_agent")});' } })
      return JSON.parse((result.output as { text: string }).text) as { hits: unknown[]; detail: { description: string; inputSchema: unknown } }
    }
    const first = await inspect()
    expect(first.hits).toEqual(expect.arrayContaining([expect.objectContaining({ name: "spawn_agent" })]))
    expect(first.detail.description).toContain("protocol-scout: Maps protocol edges for an audit.")
    expect(JSON.stringify(first.detail.inputSchema)).toMatch(/agent_type.*exact.*role/i)

    await assembly.updatePluginCapabilities({})
    await assembly.agent.run("Choose a subagent role again")
    expect(requests.at(-1)!.tools[0]!.description).not.toContain("protocol-scout")
    expect((await inspect()).detail.description).not.toContain("protocol-scout")
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("exposes restored user roles without inventing names from model settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-restore-"))
  const requests: LLMRequest[] = []
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(requests), sandbox: "danger-full-access",
    restoredState: { formatVersion: 1, jobs: [], agentTable: [], roles: [builtinRoles().find(role => role.name === "general")!, { ...customRole, name: "restored-scout" }, { ...customRole, name: "constructor" }] },
    roleSelectionFor: name => name === "settings-only" ? { provider: "unused", model: "unused" } : undefined,
  })
  try {
    await assembly.agent.run("Choose a role")
    const spawn = requests[0]!.tools.find(tool => tool.name === "spawn_agent")!
    expect(spawn.description).toContain("restored-scout: Maps protocol edges for an audit.")
    expect(spawn.description).toContain("constructor: Maps protocol edges for an audit.")
    expect(spawn.description).not.toContain("constructor for")
    expect(spawn.description).not.toContain("settings-only")
    expect(spawn.description).not.toContain("explore")
    expect(spawn.description).not.toContain("worker")
    expect(JSON.stringify(spawn.inputSchema)).toContain("restored-scout")
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("routes explicit explore and worker choices to their configured models while legacy omission uses general", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-dispatch-"))
  const parentRequests: LLMRequest[] = [], childRequests: LLMRequest[] = [], selections: unknown[] = []
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(parentRequests), sandbox: "danger-full-access", approveAll: true,
    allowSubagentModelSelection: true,
    roleSelectionFor: name => name === "explore" || name === "worker" ? { provider: "fixture", model: `model-${name}` } : undefined,
    resolveRoleModel: async selection => { selections.push(selection); return { status: "ready", binding: { client: captureModel(childRequests) } } },
  })
  try {
    for (const [taskName, role] of [["inspect", "explore"], ["implement", "worker"], ["legacy", undefined]] as const) {
      await assembly.tools.execute({ name: "spawn_agent", args: { task_name: taskName, message: "Do assigned work", ...(role ? { agent_type: role } : {}), background: false } })
    }
    expect(selections).toEqual([{ provider: "fixture", model: "model-explore" }, { provider: "fixture", model: "model-worker" }])
    expect(childRequests).toHaveLength(2)
    expect(childRequests[0]!.tools.map(tool => tool.name)).toContain("list_dir")
    expect(childRequests[0]!.tools.map(tool => tool.name)).not.toContain("write")
    expect(childRequests[1]!.tools.map(tool => tool.name)).toContain("write")
    expect(parentRequests).toHaveLength(1)
    expect(assembly.subagentState().agentTable.map(entry => entry.roleName)).toEqual(["explore", "worker", "general"])
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("points Code Mode parents to live role discovery when its selected-schema budget omits spawn_agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-budget-"))
  const requests: LLMRequest[] = []
  const fillers = Array.from({ length: 18 }, (_, i) => ({
    name: `aaa_filler_${String(i).padStart(2, "0")}`,
    description: "f".repeat(1200),
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => "ok",
  }))
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(requests), sandbox: "danger-full-access", codeMode: { mode: "only" }, additionalTools: fillers })
  try {
    await assembly.agent.run("Delegate a task")
    const description = requests[0]!.tools[0]!.description
    expect(description).not.toContain("spawn_agent: Launch")
    expect(description).toMatch(/describeTool\(["']spawn_agent["']\).*agent_type/s)
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'text(describeTool("spawn_agent"));' } })
    expect((result.output as { text: string }).text).toContain("Available roles (use exact names)")
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("does not advertise spawn discovery inside a child role without spawn access", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-role-child-guide-"))
  const requests: LLMRequest[] = []
  const assembly = await createSessionAssembly({ workspace: root, model: captureModel(requests), sandbox: "danger-full-access", codeMode: { mode: "only" }, approveAll: true })
  try {
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "inspect", agent_type: "explore", message: "Inspect", background: false } })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.tools[0]!.description).not.toContain('describeTool("spawn_agent")')
  } finally { await assembly.dispose(); await rm(root, { recursive: true, force: true }) }
})
