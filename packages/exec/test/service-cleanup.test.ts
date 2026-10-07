import { resolve } from "node:path"
import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createExecutionLease, type TransportExecutionBackend } from "@i-harness/sandbox"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { registerExec } from "../src/index.ts"

it("keeps an incomplete background handle owned and retries cleanup without relaunching or losing output", async () => {
  const authority = { kind: "unbound" as const, revision: "retry-fixture", workspaceRoot: resolve(".") }
  let treeAttempts = 0, commits = 0, releases = 0
  let consumed!: () => void
  const outputConsumed = new Promise<void>(resolve => { consumed = resolve })
  const backend: TransportExecutionBackend = {
    async probe() { return { id: "retry-fixture", availability: "available", assurance: "unverified",
      features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      return { policy, async rollback() {}, async commit(validateAuthority) {
        validateAuthority()
        commits++
        const lease = createExecutionLease({
          receipt: { executionId: "retry-fixture-1", backendId: "retry-fixture", policyFingerprint: policy.fingerprint,
            owner: spec.owner, assurance: "unverified" },
          rootExited: Promise.resolve({ exitCode: 0 }),
          async waitTreeEmpty() { if (++treeAttempts <= 2) throw new Error("tree observation unavailable") },
          settleIo: () => outputConsumed,
          async releaseResources() { releases++ },
          async terminate() {},
        })
        return { receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled },
          cancel: lease.cancel, release: lease.release, pid: 42,
          io: { output: (async function* () {
            try { yield { channel: "stdout" as const, data: Buffer.from("before-retry\n") } }
            finally { consumed() }
          })(), write: async () => {}, endInput: async () => {} },
        }
      } }
    },
  }
  const exec = registerExec(createContext(), { execution: {
    defaultOwner: { sessionId: "retry-owner" }, selectBackend: () => backend,
    resolvePolicy: owner => compileExecutionPolicy({ mode: "danger-full-access", owner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: "danger-full-access", owner: policy.owner, authority })),
  } })
  const { jobId } = await exec.runBackground({ argv: ["fixture"] })
  const deadline = Date.now() + 2_000
  while (!exec.getOutput(jobId).settlement) {
    if (Date.now() > deadline) throw new Error("initial incomplete settlement not observed")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  const incomplete = exec.getOutput(jobId)
  expect(incomplete.status).toBe("running")
  expect(incomplete.settlement?.kind).toBe("incomplete")
  expect(incomplete.cleanupDetail).toContain("tree observation unavailable")
  expect(incomplete.stdout).toBe("before-retry\n")
  await expect(exec.killJob(jobId)).rejects.toThrow(/cancellation incomplete/i)
  expect(exec.getOutput(jobId)).toMatchObject({ status: "running", settlement: { kind: "incomplete" } })
  expect(await exec.killJob(jobId)).toBe("cancellation-requested")
  const recovered = exec.getOutput(jobId)
  expect(recovered.status).toBe("killed")
  expect(recovered.settlement?.kind).toBe("settled")
  expect(recovered.stdout).toBe("before-retry\n")
  expect(recovered.stderr).toBe("")
  expect(recovered.root?.exitCode).toBe(0)
  expect(commits).toBe(1)
  expect(treeAttempts).toBe(3)
  expect(releases).toBe(1)
  await exec.dispose()
})
