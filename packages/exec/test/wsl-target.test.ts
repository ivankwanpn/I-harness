import { expect, it } from "vitest"
import { resolve } from "node:path"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createExecutionLease, snapshotProcessSpec, type ProcessSpec, type TransportExecutionBackend } from "@i-harness/sandbox"
import type { ExecCommand } from "../src/index.ts"
import { createExecService } from "../src/index.ts"

function fixture(references = false, complete = false) {
  const prepared: ProcessSpec[] = []
  const selected: (ProcessSpec | undefined)[] = []
  const backend: TransportExecutionBackend = {
    async probe() { return { id: "wsl-fixture", availability: "available", assurance: "experimental", features: {
      writeIsolation: true, readIsolation: false, denyPaths: false, referenceProtection: true, pipes: true, pty: false, retainedTree: false,
    } } },
    async prepare(spec, policy) {
      prepared.push(spec)
      if (!complete) throw new Error("prepared fixture")
      return { policy, async rollback() {}, async commit(validate) {
        validate()
        const lease = createExecutionLease({ receipt: { executionId: "fixture", backendId: "wsl-fixture", policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: "experimental" },
          rootExited: Promise.resolve({ exitCode: 0 }), waitTreeEmpty: async () => {}, settleIo: async () => {}, releaseResources: async () => {}, terminate: async () => {} })
        return { ...lease, get settled() { return lease.settled }, pid: 1, io: { output: { async *[Symbol.asyncIterator]() {} }, async write() {}, async endInput() {} } }
      } }
    },
  }
  const service = createExecService({ execution: {
    defaultOwner: { sessionId: "wsl-test" },
    selectBackend(_policy, _transport, spec) { selected.push(spec); return backend },
    resolvePolicy(owner) { return compileExecutionPolicy({ mode: "workspace-write", owner, authority: { kind: "unbound", revision: "1", workspaceRoot: resolve(".tmp/wsl-product-integration-workspace"), ...(references ? { references: [resolve(".tmp/wsl-product-integration-reference")] } : {}) } }) },
    validateAuthority() {},
  } })
  return { prepared, selected, service }
}

it("captures the trusted WSL target before backend selection and preserves Linux env keys", async () => {
  const { service, selected, prepared } = fixture()
  const env = { PATH: "/usr/bin:/bin", Path: "/case-sensitive", LANG: "C" }
  const command = { argv: ["/bin/bash", "-c", "true"], env, executionTarget: "wsl" as const }
  const pending = service.run(command)
  env.PATH = "changed"
  await expect(pending).rejects.toThrow("prepared fixture")
  expect(selected[0]).toMatchObject({ executionTarget: "wsl", argv: ["/bin/bash", "-c", "true"], env: { PATH: "/usr/bin:/bin", Path: "/case-sensitive" } })
  expect(Object.isFrozen(selected[0])).toBe(true)
  expect(prepared[0]).toEqual(selected[0])
  expect(snapshotProcessSpec(prepared[0]!)).toMatchObject({ executionTarget: "wsl" })
  await service.dispose()
})

it("admits readonly references through the dedicated reference-protection feature", async () => {
  const { service, prepared } = fixture(true)
  await expect(service.run({ argv: ["/bin/bash", "-c", "true"], env: {}, executionTarget: "wsl" })).rejects.toThrow("prepared fixture")
  expect(prepared).toHaveLength(1)
  await service.dispose()
})

it("uses root-bound complete-tree for WSL background and promotion while preserving exact transport requests", async () => {
  const { service, prepared } = fixture()
  const command = { argv: ["/bin/bash", "-c", "true"], env: {}, executionTarget: "wsl" as const }
  await expect(service.runBackground(command)).rejects.toThrow("prepared fixture")
  await expect(service.run(command, { backgroundAfterMs: 1 })).rejects.toThrow("prepared fixture")
  expect(prepared.map(spec => spec.lifetime)).toEqual(["complete-tree", "complete-tree"])
  await expect(service.launchTransport({ ...command, lifetime: "retain-tree", transport: "pipe", argumentEncoding: "crt" })).rejects.toThrow("retained-tree")
  expect(prepared).toHaveLength(2)
  await service.dispose()
})

it("reports the captured root-bound lifetime when the caller mutates its command during admission", async () => {
  const { service, prepared } = fixture(false, true)
  const command: ExecCommand = { argv: ["/bin/bash", "-c", "true"], executionTarget: "wsl" }
  const pending = service.runBackground(command)
  command.executionTarget = "host"
  const { jobId } = await pending
  expect(service.getOutput(jobId)).toMatchObject({ lifetime: "complete-tree" })
  expect(prepared[0]!.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C" })
  await service.dispose()
})
