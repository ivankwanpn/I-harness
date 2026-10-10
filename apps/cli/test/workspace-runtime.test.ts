import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { createExecutionLease, type ProcessSpec, type TransportExecutionBackend } from "@i-harness/sandbox"
import { createMockClient } from "@i-harness/llm-mock"
const observed = vi.hoisted(() => ({ resolutions: [] as any[], processes: [] as ProcessSpec[], held: undefined as undefined | { enter(): void; wait: Promise<void> } }))
vi.mock("@i-harness/workspace-runtime", () => ({ createWorkspaceRuntime: (options: any) => ({ resolve: async (configuration: any, resolutionOptions: any) => {
  observed.resolutions.push({ options, configuration, resolutionOptions })
  if (observed.held) {
    observed.held.enter()
    const wait = observed.held.wait
    await new Promise<void>((resolve, reject) => {
      wait.then(resolve)
      resolutionOptions?.signal?.addEventListener("abort", () => reject(resolutionOptions.signal.reason), { once: true })
    })
  }
  return { status: "available", source: "managed", runtimePath: ["/mnt/d/owned-runtime/bin"] }
} }) }))
vi.mock("@i-harness/sandbox-local", () => ({ readWindowsQualification: async () => undefined,
  inspectWslRuntime: async (_distribution: string, paths: string[]) => ({ paths: paths.map(windows => ({ windows, linux: "/mnt/d/fixture" })) }),
  createLocalExecutionBackends: () => {
    const backend: TransportExecutionBackend = {
      async probe() { return { id: "controlled-wsl", availability: "available", assurance: "experimental", features: { writeIsolation: true, readIsolation: false, denyPaths: false, referenceProtection: true, pipes: true, pty: false, retainedTree: false } } },
      async prepare(spec, policy) {
        observed.processes.push(spec)
        return { policy, async rollback() {}, async commit(validate) {
          validate()
          const lease = createExecutionLease({ receipt: { executionId: "cli-managed-fixture", backendId: "controlled-wsl", policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "experimental" }, rootExited: Promise.resolve({ exitCode: 0 }), waitTreeEmpty: async () => {}, settleIo: async () => {}, releaseResources: async () => {}, terminate: async () => {} })
          return { ...lease, get settled() { return lease.settled }, pid: 1, io: { output: { async *[Symbol.asyncIterator]() { yield { channel: "stdout" as const, data: Buffer.from(spec.env.PATH) } } }, async write() {}, async endInput() {} } }
        } }
      },
    }
    return { select: () => backend, async dispose() {} }
  },
}))
import { runHeadless } from "../src/run.ts"

it.each([true, false])("CLI captures managed runtime paths only when WSL workspace dependencies are enabled (%s)", async enabled => {
  mkdirSync(resolve(".tmp"), { recursive: true })
  const root = mkdtempSync(resolve(".tmp/wsl-product-integration-cli-runtime-")), prior = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = root; observed.resolutions.length = 0; observed.processes.length = 0
  try {
    const result = await runHeadless("controlled node", { workspace: root, approveAll: true, model: createMockClient([{ role: "assistant", toolCalls: [{ name: "bash", args: { command: "node --version" } }] }, { role: "assistant", text: "complete" }]), sandbox: "workspace-write", windowsSandboxBackend: "wsl", workspaceRuntimeCacheRoot: resolve(root, "runtime"), wslExecution: { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: enabled } })
    expect(result.exitCode).toBe(0)
    expect(observed.processes[0]!.executionTarget).toBe("wsl")
    if (enabled) {
      expect(observed.resolutions).toMatchObject([{ options: { cacheRoot: resolve(root, "runtime") }, configuration: { distribution: "Ubuntu", workspaceDependencies: true } }])
      expect(observed.processes[0]!.env.PATH).toBe("/mnt/d/owned-runtime/bin:/usr/bin:/bin")
    } else { expect(observed.resolutions).toHaveLength(0); expect(observed.processes[0]!.env.PATH).toBe("/usr/bin:/bin") }
  } finally { if (prior === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }) }
})
it("cancelling a run cancels its pending managed runtime resolution before any model or shell call", async () => {
  mkdirSync(resolve(".tmp"), { recursive: true })
  const root = mkdtempSync(resolve(".tmp/wsl-product-integration-cli-cancel-")), previous = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = root; observed.resolutions.length = 0; observed.processes.length = 0
  let entered!: () => void, release!: () => void
  const active = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  observed.held = { enter: entered, wait: held }
  const stop = new AbortController()
  const run = runHeadless("cancelled fixture", { workspace: root, workspaceRuntimeCacheRoot: resolve(root, "runtime"), signal: stop.signal, modelPolicy: "test-mock", sandbox: "workspace-write", windowsSandboxBackend: "wsl", wslExecution: { distribution: "Ubuntu", workspaceDependencies: true, networkAccess: false } })
  try {
    await active; stop.abort()
    expect(observed.resolutions[0].resolutionOptions?.signal?.aborted).toBe(true)
    expect((await run).exitCode).toBe(1)
    expect(observed.processes).toHaveLength(0)
  } finally { release(); observed.held = undefined; await run; if (previous === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = previous; rmSync(root, { recursive: true, force: true }) }
})
