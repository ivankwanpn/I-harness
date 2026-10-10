import { expect, it } from "vitest"
import { createSessionAssembly } from "../src/assembly.ts"
import { createSessionService } from "../src/service.ts"
import type { AuthorityState } from "@i-harness/sandbox"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { resolve } from "node:path"
import type { ExecService } from "@i-harness/exec"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createMockClient } from "@i-harness/llm-mock"
import type { ExecutionReceipt } from "@i-harness/sandbox"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) { if (Date.now() > deadline) throw new Error("controlled writer did not start"); await delay(10) }
}

it("awaits narrowing of a real writer in an assembly still mounting extensions", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(resolve(parent, "sandbox-redesign-mount-mode-"))
  const ready = resolve(root, "ready"), late = resolve(root, "late")
  let release!: () => void
  const gate = new Promise<void>(yes => { release = yes })
  let writer: Promise<unknown> | undefined
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", sandbox: "danger-full-access", extensionsFor: async () => ({ options: {},
    mount: async assembly => {
      writer = assembly.ctx.services.get<ExecService>("exec/service").run({ argv: [process.execPath, "-e", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1000);setTimeout(()=>{},2000)`] }).catch(() => {})
      await gate
    },
  }) })
  const creating = service.assemblyFor("mounting")
  try {
    await waitForFile(ready)
    await service.updateSandboxMode("read-only")
    await delay(1200)
    expect(existsSync(late)).toBe(false)
  } finally { release(); await creating; await service.close(); await writer }
}, 15_000)

it.each(["revoke", "remove-root"] as const)("drains a real delayed writer before acknowledging %s", async change => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(resolve(parent, "sandbox-redesign-writer-"))
  const a = resolve(root, "a"), b = resolve(root, "b")
  mkdirSync(a); mkdirSync(b)
  const ready = resolve(a, "ready"), late = resolve(b, "late")
  let authority: AuthorityState = { kind: "bound", revision: "1", primaryRoot: a, roots: [a, b], references: [] }
  const assembly = await createSessionAssembly({ sessionId: "writer", workspace: a, modelPolicy: "test-mock", sandbox: "workspace-write", executionAuthority: () => authority })
  const exec = assembly.ctx.services.get<ExecService>("exec/service")
  const run = exec.run({ argv: [process.execPath, "-e", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1500);setTimeout(()=>{},3000)`] }).then(value => ({ value }), error => ({ error }))
  try {
    await waitForFile(ready)
    authority = change === "revoke" ? { kind: "revoked", revision: "2", reason: "controlled revoke" }
      : { kind: "bound", revision: "2", primaryRoot: a, roots: [a], references: [] }
    await assembly.reconcileExecutionAuthority()
    await run
    await delay(1700)
    expect(existsSync(late)).toBe(false)
  } finally { await assembly.dispose() }
}, 20_000)

it("refuses unknown actual dispatch identity before the tool body", async () => {
  const assembly = await createSessionAssembly({ sessionId: "main", workspace: process.cwd(), modelPolicy: "test-mock", approveAll: true })
  let called = false
  assembly.tools.register({ name: "identity_probe", description: "identity", inputSchema: { type: "object", properties: {} }, execute: async () => { called = true; return {} } })
  try {
    const prepared = await assembly.tools.prepare({ name: "identity_probe", args: {} }, undefined, { sessionId: "spoofed-child" })
    await expect(assembly.tools.dispatch(prepared)).rejects.toThrow(/caller unavailable/)
    expect(called).toBe(false)
  } finally { await assembly.dispose() }
})

it("binds durable child and nested Code Mode receipts and permits only trusted parent visibility", async () => {
  const parent = resolve(".tmp"); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(resolve(parent, "sandbox-redesign-caller-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, "sessions")))
  await coordinator.create({ sessionId: "main" })
  const receipts: ExecutionReceipt[] = []
  let exec!: ExecService
  const probe = { name: "owner_probe", description: "Controlled ownership probe", inputSchema: { type: "object", properties: {} },
    async execute() {
      const { jobId } = await exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{},1000)"] })
      receipts.push(exec.getOutput(jobId).receipt!)
      return { jobId }
    } }
  const model = createMockClient([
    { role: "assistant", toolCalls: [{ name: "code_exec", args: { code: "text(await tools.owner_probe({}))", yield_time_ms: 1000 } }] },
    { role: "assistant", text: "done" },
  ])
  const assembly = await createSessionAssembly({ sessionId: "main", coordinator, workspace: root, model, approveAll: true,
    sandbox: "danger-full-access", codeMode: { mode: "mixed" }, additionalTools: [probe],
    pluginAgents: [{ name: "owner-worker", description: "worker", systemPrompt: "work", tools: ["owner_probe", "code_exec", "code_wait"] }] })
  exec = assembly.ctx.services.get<ExecService>("exec/service")
  try {
    await assembly.tools.execute({ name: "owner_probe", args: {} })
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "identity", agent_type: "owner-worker", message: "probe", fork_turns: "none", background: false } })
    expect(receipts).toHaveLength(2)
    expect(receipts[0]!.owner).toEqual({ sessionId: "main" })
    const child = receipts[1]!.owner
    expect(child.sessionId).not.toBe("main")
    expect(child.parentSessionId).toBe("main")
    expect((await coordinator.profile(child.sessionId)).meta.parentSession).toBe("main")
    expect(exec.listJobs().map(job => job.owner)).toContain(child.sessionId)
    for (const job of exec.listJobs()) await exec.killJob(job.id)
  } finally { await assembly.dispose(); await coordinator.close() }
}, 20_000)

it("refuses revoked authority for filesystem writes even in full access", async () => {
  const workspace = resolve(".tmp/sandbox-redesign-authority-unit")
  mkdirSync(workspace, { recursive: true })
  let authority: AuthorityState = { kind: "unbound", revision: "1", workspaceRoot: workspace }
  const assembly = await createSessionAssembly({ workspace, modelPolicy: "test-mock", sandbox: "danger-full-access", executionAuthority: () => authority })
  try {
    authority = { kind: "revoked", revision: "2", reason: "project removed" }
    await expect(assembly.tools.execute({ name: "write", args: { path: "SHOULD-NOT-EXIST-authority.txt", text: "forbidden" } })).rejects.toThrow(/revoked|removed/)
  } finally { await assembly.dispose() }
})
