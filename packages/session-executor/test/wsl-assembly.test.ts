import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { createExecutionLease, type ProcessSpec, type TransportExecutionBackend } from "@i-harness/sandbox"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
const observed = vi.hoisted(() => ({ requests: [] as { spec: ProcessSpec; options: any }[] }))
vi.mock("@i-harness/sandbox-local", () => ({
  readWindowsQualification: async () => undefined,
  inspectWslRuntime: async (_distribution: string, paths: string[]) => ({ paths: paths.map(windows => ({ windows, linux: "/mnt/d/fixture" })) }),
  createLocalExecutionBackends: (options: any) => {
    const backend: TransportExecutionBackend = {
      async probe() { return { id: "wsl-fixture", availability: "available", assurance: "experimental", features: {
        writeIsolation: true, readIsolation: false, denyPaths: false, referenceProtection: true, pipes: true, pty: false, retainedTree: false,
      } } },
      async prepare(spec, policy) {
        observed.requests.push({ spec, options })
        return { policy, async rollback() {}, async commit(validate) {
          validate()
          let drained!: () => void
          const ioDone = new Promise<void>(resolve => { drained = resolve })
          const lease = createExecutionLease({ receipt: { executionId: `fixture-${observed.requests.length}`, backendId: "wsl-fixture", policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "experimental" },
            rootExited: Promise.resolve({ exitCode: 0 }), waitTreeEmpty: async () => {}, settleIo: () => ioDone, releaseResources: async () => {}, terminate: async () => {} })
          return { ...lease, pid: 1, get settled() { return lease.settled }, io: { output: (async function* () { try { yield { channel: "stdout" as const, data: Buffer.from("Linux fixture") } } finally { drained() } })(), async write() {}, async endInput() {} } }
        } }
      },
    }
    return { select: () => backend, async dispose() {} }
  },
}))
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"

function directory() { mkdirSync(resolve(".tmp"), { recursive: true }); return mkdtempSync(resolve(".tmp/wsl-product-integration-assembly-")) }

it("runs registered Bash and Code Mode shell through captured WSL service options and reference authority", async () => {
  const root = directory()
  let selected = { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: true }
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "fixture" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: root, model, approveAll: true, sandbox: "workspace-write", windowsSandboxBackendFor: () => "wsl",
    wslExecutionFor: () => selected, codeMode: { mode: "mixed" },
    executionAuthorityFor: async () => () => ({ kind: "unbound", revision: "fixture", workspaceRoot: root, references: [resolve(root, "../reference")] }),
  })
  observed.requests.length = 0
  try {
    const old = await service.assemblyFor("old")
    selected = { distribution: "Ubuntu-New", networkAccess: true, workspaceDependencies: false }
    expect((await old.tools.execute({ name: "bash", args: { command: "uname -s" } })).output).toMatchObject({ stdout: "Linux fixture", exitCode: 0 })
    expect((await old.tools.execute({ name: "code_exec", args: { code: 'text(await tools.shell({command:"pwd"}));' } })).output).toMatchObject({ status: "completed" })
    expect(observed.requests.slice(0, 2)).toMatchObject([{ spec: { executionTarget: "wsl", argv: ["/bin/bash", "--noprofile", "--norc", "-c", "uname -s"] }, options: { wslExecution: { distribution: "Ubuntu", networkAccess: false } } }, { spec: { executionTarget: "wsl", env: { PATH: "/usr/bin:/bin", LANG: "C" } } }])
    await old.agent.run("show prompt")
    expect(requests[0]!.systemPrompt).toContain("Linux workspace: /mnt/d/fixture")
    const next = await service.assemblyFor("next")
    await next.tools.execute({ name: "shell", args: { command: "pwd" } })
    expect(observed.requests.at(-1)!.options.wslExecution).toMatchObject(selected)
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }) }
})

it("inherits the captured Linux workspace and exec owner through a real child Code Mode registry", async () => {
  const root = directory()
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  const requests: LLMRequest[] = []
  const child: ModelClient = { async *stream(request) {
    requests.push(request)
    if (request.messages.at(-1)?.role === "user") yield { type: "tool_call", call: { name: "code_exec", args: { code: 'text(await tools.shell({command:"uname -s"}));' } } }
    else yield { type: "text/chunk", text: "child complete" }
    yield { type: "end" }
  } }
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator), approveAll: true,
    sandbox: "workspace-write", windowsSandboxBackend: "wsl", wslExecution: { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: true }, codeMode: { mode: "only" },
    pluginAgents: [{ name: "linux-probe", description: "Controlled child", systemPrompt: "Use Linux Bash", tools: ["shell", "code_exec", "code_wait"] }],
    roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  observed.requests.length = 0
  try {
    const assembly = await service.assemblyFor("parent")
    await assembly.tools.get("spawn_agent")!.execute({ task_name: "probe", agent_type: "linux-probe", message: "Run controlled fixture", fork_turns: "none", background: false }, { sessionId: "parent" })
    await vi.waitFor(() => expect(observed.requests).toHaveLength(1))
    expect(observed.requests[0]!.spec).toMatchObject({ executionTarget: "wsl", owner: { parentSessionId: "parent" } })
    expect(requests[0]!.systemPrompt).toContain("Linux workspace: /mnt/d/fixture")
  } finally { await service.close(); await coordinator.close(); rmSync(root, { recursive: true, force: true }) }
}, 15_000)
