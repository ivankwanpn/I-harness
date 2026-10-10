import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { createHookTrustStore, sha256ClaudePluginTreeSync } from "@i-harness/hooks"
import { createSessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { LLMRequest, ModelClient } from "../../llm-seam/src/index.ts"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"
import { mountedHookAuthority, pluginExtensions } from "../src/plugin-mount.ts"

it.each(["code-reviewer", "explore"] as const)("installs official plugin snapshots and runs their canonical startup hook and real %s child under Desktop authority", async role => {
  const root = await mkdtemp(join(tmpdir(), "ih-official-plugin-authority-"))
  const configDir = join(root, "config"), pluginsRoot = join(configDir, "plugins")
  const registry = new PluginRegistry({ root: pluginsRoot })
  const fixture = fileURLToPath(new URL("./fixtures/official-plugins", import.meta.url))
  await registry.addSource(fixture)
  for (const name of ["explanatory-output-style", "feature-dev"]) {
    await registry.install(`Official fixture subset__${name}`)
    await registry.enable(`Official fixture subset__${name}`)
  }
  const installed = join(pluginsRoot, "Official fixture subset__explanatory-output-style")
  const grantPath = join(configDir, "hook-trust.json")
  createHookTrustStore(grantPath).approve({ sha256: sha256ClaudePluginTreeSync(installed), script: installed, handlerId: "claude:SessionStart:0:0" })
  const inputs = registry.runtimeInputs()
  expect(inputs.agentDescriptors.some(agent => agent.name === "code-reviewer")).toBe(true)
  expect(inputs.hookConfigs).toEqual([join(installed, "hooks", "hooks.json")])
  await writeFile(join(root, "fixture.txt"), "Official reviewer read fixture")
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "lead" })
  const requests: LLMRequest[] = [], diagnostics: string[] = []
  const parent: ModelClient = { async *stream() { yield { type: "text/chunk", text: "Received" }; yield { type: "end" } } }
  const child: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) yield { type: "tool_call", call: { id: "official-read", name: "read", args: { path: "fixture.txt" } } }
    else if (requests.length === 2) yield { type: "tool_call", call: { id: "official-glob", name: "glob", args: { pattern: "fixture.txt" } } }
    else if (requests.length === 3) yield { type: "tool_call", call: { id: "official-grep", name: "grep", args: { pattern: "Official reviewer read fixture", mode: "literal", path: "fixture.txt" } } }
    else yield { type: "text/chunk", text: "Official role completed" }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: root, model: parent, coordinator, sandbox: "read-only", approveAll: true,
    extensionsFor: async id => pluginExtensions(inputs, configDir, id, rows => { diagnostics.push(...rows) }),
    roleSelectionFor: name => name === role ? { provider: "local", model: "scripted-reviewer" } : undefined,
    allowSubagentModelSelection: true, resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  try {
    const assembly = await service.assemblyFor("lead")
    const policy = () => approvalPolicyIdentity(assembly, { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined,
      hookConfigs: inputs.hookConfigs, hookAuthority: () => mountedHookAuthority(assembly, inputs.hookConfigs), grantPaths: [grantPath], pluginAuthority: inputs })
    expect(policy()).toBeDefined()
    createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: policy }).attach(assembly)
    expect(assembly.tools.schemas().some(tool => tool.name === "glob" || tool.name === "grep")).toBe(false)
    const prepared = await assembly.tools.prepare({ name: "spawn_agent", args: { task_name: "official-reviewer", agent_type: role, message: "Read fixture.txt" } }, undefined, { sessionId: "lead" })
    await assembly.tools.dispatch(prepared)
    await vi.waitFor(() => expect(assembly.subagentState().jobs.every(job => job.status !== "running")).toBe(true), { timeout: 5_000 })
    expect(requests).toHaveLength(4)
    expect(requests[0]!.systemPrompt).toContain(role === "code-reviewer" ? "You are an expert code reviewer" : "You are an exploration agent")
    expect(requests[0]!.systemPrompt, diagnostics.join("\n")).toContain("explanatory' output style mode")
    expect(requests[0]!.tools.map(tool => tool.name).sort()).toEqual(["glob", "grep", "list_dir", "read"])
    const entry = assembly.subagentState().agentTable[0]!
    const cold = await coordinator.snapshot!(entry.sessionId!)
    expect(cold.session.events.find(event => event.type === "tool/result" && event.callId === "official-read")).toMatchObject({ output: { content: "Official reviewer read fixture" } })
    const glob = cold.session.events.find(event => event.type === "tool/result" && event.callId === "official-glob")
    expect(glob).toMatchObject({ output: { matches: ["fixture.txt"] } })
    const grep = cold.session.events.find(event => event.type === "tool/result" && event.callId === "official-grep")
    expect(grep).toMatchObject({ output: { matches: [expect.objectContaining({ path: "fixture.txt", text: "Official reviewer read fixture" })] } })
    expect(assembly.tools.schemas().some(tool => tool.name === "glob" || tool.name === "grep")).toBe(false)
    expect(entry.modelLabel).toBe("local:scripted-reviewer")
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
