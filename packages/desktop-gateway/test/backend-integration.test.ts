import { expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createSessionManagementFence } from "../src/session-management-fence.ts"
import { createSessionManagement } from "../src/session-management.ts"
import { approvalPolicyIdentity } from "../src/approval-policy-identity.ts"
import { createDesktopExecution } from "../src/execution.ts"
import { createAgentProcesses } from "../src/agent-processes.ts"

it("cold execution/process inspection refuses a recovering-only backend and leaves incomplete JSONL unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-cold-read-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "interrupted" })
  await coordinator.append("interrupted", [{ type: "turn/start", seq: 0 }])
  const { readFile } = await import("node:fs/promises")
  const file = join(root, "interrupted.jsonl"), before = await readFile(file, "utf8")
  const recoveringOnly = { ...coordinator, snapshot: undefined }
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock" })
  try {
    const execution = createDesktopExecution(recoveringOnly, service), processes = createAgentProcesses(recoveringOnly, service)
    const results = await Promise.allSettled([execution.read("interrupted"), processes.read("interrupted"), processes.jobOutput("interrupted", "saved-shell"), processes.terminalOutput("interrupted", "saved-pty")])
    expect(await readFile(file, "utf8")).toBe(before)
    for (const result of results) { expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(String(result.reason)).toMatch(/read.only snapshot/i) }
    expect(service.hasAssembly("interrupted")).toBe(false)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("refuses busy management before draining a held model turn and fences actual cold assembly creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-service-fence-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "busy" }); await coordinator.create({ sessionId: "cold" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const fence = createSessionManagementFence()
  const service = createSessionService({ workspace: root, sessionOperation: fence, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    model: { async *stream() { entered.resolve(); await release.promise; yield { type: "text/chunk" as const, text: "fixture" }; yield { type: "end" as const } } }, sandbox: "read-only" })
  const manager = createSessionManagement(coordinator, service, undefined, { fence, workspace: root, sessionDir: root, pendingInteractions: async () => [], drainSession: id => service.closeSession(id) })
  const submit = service.submit("busy", "fixture", new AbortController().signal)
  try {
    await entered.promise
    await expect(Promise.race([manager.mutate("busy", "delete"), new Promise((_, reject) => setTimeout(() => reject(new Error("busy refusal timed out")), 500))])).rejects.toThrow(/busy/)
    const hold = Promise.withResolvers<void>(), locked = Promise.withResolvers<void>()
    const mutation = fence.exclusive("cold", async () => { locked.resolve(); await hold.promise; fence.retire("cold") })
    await locked.promise
    await expect(service.assemblyFor("cold")).rejects.toThrow(/management/)
    expect(service.hasAssembly("cold")).toBe(false)
    hold.resolve(); await mutation
    await expect(service.submit("cold", "fixture", new AbortController().signal)).rejects.toThrow(/deleted/)
  } finally { release.resolve(); await submit; await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("drains nested admitted producers without a stale context admitting later writers", async () => {
  const fence = createSessionManagementFence(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), childDone = Promise.withResolvers<void>()
  let later!: () => Promise<void>, child!: Promise<void>
  const parent = fence.run("session", async () => {
    entered.resolve(); await resume.promise
    child = fence.run("session", async () => { await childDone.promise })
    later = () => fence.run("session", async () => {})
  })
  await entered.promise
  let mutated = false
  const management = fence.exclusive("session", async () => { mutated = true; fence.retire("session") })
  resume.resolve(); await parent
  expect(mutated).toBe(false)
  await expect(later()).rejects.toThrow(/management/)
  childDone.resolve(); await child; await management
  expect(mutated).toBe(true)
})

it("derives policy evidence from actual Plan, registry, roles, membership, Hook content and grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-policy-identity-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "owner" })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy: "test-mock", sandbox: "read-only" })
  try {
    const assembly = await service.assemblyFor("owner"), hookPath = join(root, "hooks.json"), scriptPath = join(root, "hook.cjs"), grantPath = join(root, "grants.json")
    await writeFile(hookPath, JSON.stringify({ handlers: [{ trust: { script: "hook.cjs" } }] })); await writeFile(scriptPath, "fixture-one"); await writeFile(grantPath, "fixture-grant")
    let roots = [root]
    const options = { workspace: root, sandbox: "read-only", approval: "ask-all", project: () => ({ id: "p", name: "Project", primaryRoot: root, roots }), hookConfigs: [hookPath], grantPaths: [grantPath], pluginAuthority: [] }
    const identity = () => approvalPolicyIdentity(assembly, options)
    const initial = identity()!; expect(initial.workspaceId).toBe(root)
    append(assembly.session, { type: "plan/mode", mode: "on" }); expect(identity()?.revision).not.toBe(initial.revision)
    const plan = identity()!
    roots = [root, join(root, "other")]; expect(identity()?.revision).not.toBe(plan.revision)
    const membership = identity()!
    await writeFile(scriptPath, "fixture-two"); expect(identity()?.revision).not.toBe(membership.revision)
    const script = identity()!
    await writeFile(grantPath, "changed-grant"); expect(identity()?.revision).not.toBe(script.revision)
    const grants = identity()!
    assembly.tools.unregister("read"); expect(identity()?.revision).not.toBe(grants.revision)
    await rm(scriptPath); expect(identity()).toBeUndefined()
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
