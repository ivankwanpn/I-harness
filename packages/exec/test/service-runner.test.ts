import { resolve } from "node:path"
import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createExecutionLease, SandboxUnavailableError, type ExecutionOwner, type TransportExecutionBackend } from "@i-harness/sandbox"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { registerExec } from "../src/index.ts"

it("classifies a selected backend runner failure from its frozen metadata", async () => {
  const workspaceRoot = resolve(".")
  const authority = { kind: "unbound" as const, revision: "runner-test", workspaceRoot }
  const owner: ExecutionOwner = { sessionId: "runner-test-owner" }
  let consumed!: () => void
  const outputConsumed = new Promise<void>(resolve => { consumed = resolve })
  const backend: TransportExecutionBackend = {
    async probe() { return { id: "runner-test", availability: "available", assurance: "unverified",
      features: { writeIsolation: true, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: false } } },
    async prepare(spec, policy) {
      return {
        policy,
        async commit(validateAuthority) {
          validateAuthority()
          const lease = createExecutionLease({
            receipt: { executionId: "runner-test-1", backendId: "runner-test", policyFingerprint: policy.fingerprint,
              owner: spec.owner, assurance: "unverified" },
            rootExited: Promise.resolve({ exitCode: 125 }),
            waitTreeEmpty: async () => {}, settleIo: () => outputConsumed, releaseResources: async () => {}, terminate: async () => {},
          })
          return {
            receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled },
            cancel: lease.cancel, release: lease.release, pid: 125,
            io: {
              output: (async function* () {
                try { yield { channel: "stderr" as const, data: Buffer.from("bwrap: failed to create namespace") } }
                finally { consumed() }
              })(),
              write: async () => {}, endInput: async () => {},
            },
            runner: Object.freeze({ enforcement: "full" as const, denialSignatures: Object.freeze(["permission denied"]),
              runnerFailureRules: Object.freeze([{ allowedExitCodes: Object.freeze([125]), fatalSignatures: Object.freeze(["bwrap: failed to"]) }]) }),
          }
        },
        async rollback() {},
      }
    },
  }
  const exec = registerExec(createContext(), { execution: {
    defaultOwner: owner, selectBackend: () => backend,
    resolvePolicy: actualOwner => compileExecutionPolicy({ mode: "read-only", owner: actualOwner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: "read-only", owner: policy.owner, authority })),
  } })
  await expect(exec.run({ argv: ["test-runner"], sandbox: { mode: "read-only", workspaceRoot } })).rejects.toMatchObject({
    name: SandboxUnavailableError.name, kind: "command-not-run", detail: expect.stringContaining("bwrap: failed to"),
  })
  await exec.dispose()
})
