import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import type { ModelClient } from "../../llm-seam/src/index.ts"
import { createSessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createHookTrustStore } from "@i-harness/hooks"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"
import { pluginExtensions, mountedHookAuthority } from "../src/plugin-mount.ts"

async function childHookFixture(spawnName: "spawn_agent" | "spawn_teammate", change?: "script" | "config" | "grant" | "malformed" | "uninstalled", format: "claude" | "native" = "claude") {
  const root = await mkdtemp(join(tmpdir(), "ih-child-hook-authority-"))
  const configDir = join(root, "config"), pluginRoot = join(configDir, "plugins", "fixture")
  const hookPath = join(pluginRoot, "hooks", "hooks.json")
  await mkdir(join(pluginRoot, "hooks"), { recursive: true })
  const grantPath = join(configDir, "hook-trust.json")
  await writeFile(grantPath, JSON.stringify({ grants: [] }))
  const scriptPath = join(pluginRoot, format === "claude" ? "startup.sh" : "startup.js")
  if (format === "claude") {
    await writeFile(hookPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo fixture-startup" }] }] } }))
    await writeFile(scriptPath, "echo fixture-startup")
  } else {
    const script = 'process.stdout.write("{}")', sha256 = createHash("sha256").update(script).digest("hex")
    await writeFile(scriptPath, script)
    await writeFile(hookPath, JSON.stringify({ version: 1, handlers: [{ id: "native-startup", event: "session/start", type: "command", command: { cmd: process.execPath, args: [scriptPath] }, trust: { script: "../startup.js", sha256 } }] }))
    createHookTrustStore(grantPath).approve({ sha256, script: scriptPath, handlerId: "native-startup" })
  }
  await writeFile(join(root, "fixture.txt"), "Owned plugin fixture")
  const inputs = { skillDirs: [], mcpServerConfigs: {}, commandDescriptors: [], agentDescriptors: [], hookConfigs: [hookPath] }
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "lead" })
  const parent: ModelClient = controlledModel(request => ({ async *stream() { yield { type: "text/chunk", text: "Received" }; yield { type: "end" } } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  let rounds = 0
  const child: ModelClient = controlledModel(request => ({ async *stream() {
    if (++rounds === 1) yield { type: "tool_call", call: { id: "ordinary-read", name: "read", args: { path: "fixture.txt" } } }
    else if (rounds === 2 && !change) yield { type: "tool_call", call: { id: "wrapper-read", name: "code_exec", args: { code: spawnName === "spawn_teammate"
      ? 'const file = await tools.read({path:"fixture.txt"});text(file.content);const members = await tools.list_members({});text(members.members.map(m=>m.name));const tasks = await tools.team_task_list({});text(tasks.tasks)'
      : 'const file = await tools.read({path:"fixture.txt"});text(file.content)' } } }
    else yield { type: "text/chunk", text: "Child completed" }
    yield { type: "end" }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, model: parent, sandbox: "read-only", approveAll: true, coordinator,
    team: {}, concurrentSessionTeams: true, codeMode: { mode: "mixed" },
    extensionsFor: async () => pluginExtensions(inputs, configDir, "lead", () => {}),
    roleSelectionFor: () => ({ provider: "local", model: "fixture" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  const release = Promise.withResolvers<void>(), arrived = Promise.withResolvers<void>()
  try {
    const assembly = await service.assemblyFor("lead")
    let readBodies = 0
    const read = assembly.tools.get("read")!
    assembly.tools.unregister("read")
    assembly.tools.register({ ...read, execute: async (args, exec) => { readBodies++; return read.execute(args, exec) } })
    const policy = () => approvalPolicyIdentity(assembly, { workspace: root, sandbox: "read-only", approval: "dangerous", project: () => undefined,
      hookConfigs: inputs.hookConfigs, hookAuthority: () => mountedHookAuthority(assembly, inputs.hookConfigs), grantPaths: [grantPath], pluginAuthority: inputs })
    const observed: { policyAvailable: boolean; ownedCaller: boolean; bindingValid: boolean }[] = []
    const owned = assembly.ownedToolCaller!
    assembly.ownedToolCaller = input => {
      const caller = owned(input)
      observed.push({ policyAvailable: policy() !== undefined, ownedCaller: caller !== undefined, bindingValid: input.validateBinding?.() === true })
      return caller
    }
    createApprovalRulesAdapter({ filePath: join(root, "rules.json"), policyIdentity: policy }).attach(assembly)
    if (change) assembly.ctx.onCascade("tools/execute", async (input, next) => {
      const call = input as { name: string; exec: { sessionId?: string } }
      if (call.name === "read" && call.exec.sessionId !== "lead") { arrived.resolve(); await release.promise }
      return next()
    })
    const spawn = await assembly.tools.prepare({ name: spawnName, args: spawnName === "spawn_agent"
      ? { task_name: "helper", agent_type: "explore", message: "Read the fixture", fork_turns: "none" }
      : { name: "helper", description: "Read fixture", prompt: "Read the fixture", context: "fresh" } }, undefined, { sessionId: "lead" })
    await assembly.tools.dispatch(spawn)
    if (change) {
      await arrived.promise
      if (change === "script") await writeFile(scriptPath, "changed artifact")
      if (change === "config") await writeFile(hookPath, JSON.stringify({ hooks: { SessionStart: [] } }))
      if (change === "grant") await writeFile(grantPath, JSON.stringify({ grants: ["changed-grant"] }))
      if (change === "malformed") await writeFile(hookPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: "invalid" }] } }))
      if (change === "uninstalled") await rm(pluginRoot, { recursive: true, force: true })
      release.resolve()
    }
    await vi.waitFor(() => expect(assembly.subagentState().jobs.every(job => job.status !== "running")).toBe(true))
    expect(observed).not.toEqual([])
    expect(observed.every(row => row.ownedCaller && row.bindingValid)).toBe(true)
    if (!change) expect(observed.every(row => row.policyAvailable), "all real caller/binding predicates passed; the Desktop policy must cover mounted Claude hooks").toBe(true)
    const entry = assembly.subagentState().agentTable.find(row => row.path.endsWith("/helper"))!
    const snapshot = await coordinator.snapshot!(entry.sessionId!)
    const results = snapshot.session.events.filter(event => event.type === "tool/result")
    if (change) {
      expect(readBodies).toBe(0)
      expect(JSON.stringify({ events: snapshot.session.events, entry, jobs: assembly.subagentState().jobs })).toContain("prepared approval authority or policy changed before dispatch")
      return
    }
    expect(results.find(event => event.callId === "ordinary-read")).toMatchObject({ output: { content: "Owned plugin fixture" } })
    expect(results.find(event => event.callId === "wrapper-read")).not.toHaveProperty("isError")
    expect(JSON.stringify(results.find(event => event.callId === "wrapper-read")?.output)).toContain("Owned plugin fixture")
    if (spawnName === "spawn_teammate") expect(JSON.stringify(results.find(event => event.callId === "wrapper-read")?.output)).toContain("helper")
    expect(results.some(event => event.isError)).toBe(false)
  } finally {
    release.resolve()
    await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true })
  }
}

it.each(["spawn_agent", "spawn_teammate"] as const)("runs real %s ordinary and Code Mode tools through Desktop authority with a Claude startup plugin", async spawnName => { await childHookFixture(spawnName) })

it.each(["spawn_agent", "spawn_teammate"] as const)("runs real %s tools through the same normalized native hook authority", async spawnName => { await childHookFixture(spawnName, undefined, "native") })

it.each(["script", "config", "grant", "malformed", "uninstalled"] as const)("refuses real child dispatch after Claude plugin %s authority changes", async change => {
  await childHookFixture("spawn_teammate", change)
})

it("refuses a real child after its normalized native hook artifact changes", async () => { await childHookFixture("spawn_teammate", "script", "native") })
