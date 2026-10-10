import { snapshotProcessSpec } from "@i-harness/sandbox"
import type {
  BackendProbe, CompiledSandboxPolicy, ConfinedArgv, PreparedTransportExecution, ProcessSpec,
  SandboxProvider, TransportExecutionBackend, TransportExecutionHandle,
  StopReason,
} from "@i-harness/sandbox"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type { AclSandboxProvider } from "@i-harness/sandbox-windows-acl"

export interface LegacyWindowsBackend extends TransportExecutionBackend { dispose(): Promise<void> }

function nativeWrapperPolicy(policy: CompiledSandboxPolicy): CompiledSandboxPolicy {
  const authority = policy.authorityKind === "unbound"
    ? { kind: "unbound" as const, revision: policy.authorityRevision, workspaceRoot: policy.primaryRoot }
    : { kind: "bound" as const, revision: policy.authorityRevision, primaryRoot: policy.primaryRoot,
      roots: policy.authorityRoots, references: [] }
  // The native Job owns the trusted runner. The runner applies the original
  // restricted-token policy to its child; the wrapper policy grants nothing.
  return compileExecutionPolicy({ mode: "danger-full-access", owner: policy.owner, authority })
}

function copyRunner(wrapped: ConfinedArgv): NonNullable<TransportExecutionHandle["runner"]> {
  return Object.freeze({ enforcement: wrapped.enforcement,
    denialSignatures: Object.freeze([...wrapped.denialSignatures]),
    runnerFailureRules: Object.freeze(wrapped.runnerFailureRules.map(rule => Object.freeze({
      ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: Object.freeze([...rule.allowedExitCodes]) }),
      fatalSignatures: Object.freeze([...rule.fatalSignatures]),
      ...(rule.informationalLines === undefined ? {} : { informationalLines: Object.freeze([...rule.informationalLines]) }),
    }))),
  })
}

/** Restricted child under the existing ACL runner, with the runner in a native unrestricted Job. */
export function createLegacyWindowsBackend(
  provider: SandboxProvider & Partial<Pick<AclSandboxProvider, "confineExecution" | "dispose">>, nativeOwner: TransportExecutionBackend,
): LegacyWindowsBackend {
  let disposed = false
  return {
    async probe(): Promise<BackendProbe> {
      const owner = await nativeOwner.probe()
      return { id: "windows-acl-legacy", availability: disposed ? "unavailable" : owner.availability,
        assurance: "unverified", features: { writeIsolation: true, readIsolation: false, denyPaths: false,
          pipes: owner.features.pipes, pty: false, retainedTree: false },
        detail: disposed ? "legacy adapter disposed" : owner.detail }
    },
    async prepare(input: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedTransportExecution> {
      if (disposed) throw new Error("legacy adapter disposed")
      if (policy.mode === "danger-full-access") throw new Error("legacy adapter requires a confined policy")
      const spec = snapshotProcessSpec(input)
      if (spec.transport !== "pipe") throw new Error("legacy Windows PTY is unsupported")
      if (spec.lifetime !== "complete-tree") throw new Error("legacy runner cannot retain descendants")
      if (spec.owner.sessionId !== policy.owner.sessionId || spec.owner.parentSessionId !== policy.owner.parentSessionId) {
        throw new Error("legacy owner mismatch")
      }
      if (policy.mode === "workspace-write" && JSON.stringify(policy.writeRoots) !== JSON.stringify(policy.authorityRoots)) {
        throw new Error("legacy write roots differ from declared authority roots")
      }
      if (policy.mode === "read-only" && policy.writeRoots.length) throw new Error("read-only legacy policy has write grants")
      const aclPolicy = { mode: policy.mode, workspaceRoot: policy.primaryRoot,
        workspaceRoots: policy.authorityRoots, sessionId: spec.owner.sessionId }
      if (spec.argumentEncoding === "cmd-verbatim" && !provider.confineExecution) {
        throw new Error("legacy ACL provider cannot preserve cmd-verbatim argument encoding")
      }
      const wrapped = provider.confineExecution
        ? provider.confineExecution(spec.argv, aclPolicy, spec.argumentEncoding)
        : provider.confine(spec.argv, aclPolicy)
      const runner = copyRunner(wrapped)
      const wrapperSpec = snapshotProcessSpec({ ...spec, argv: wrapped.argv, argumentEncoding: "crt" })
      const nativePrepared = await nativeOwner.prepare(wrapperSpec, nativeWrapperPolicy(policy), signal)
      const original = JSON.stringify(policy)
      return {
        policy,
        async commit(validateAuthority) {
          if (disposed) throw new Error("legacy adapter disposed")
          if (JSON.stringify(policy) !== original) throw new Error("legacy policy changed after preparation")
          const native = await nativePrepared.commit(() => {
            validateAuthority()
            if (JSON.stringify(policy) !== original) throw new Error("legacy policy changed before native commit")
          })
          if (native.receipt.owner.sessionId !== spec.owner.sessionId
            || native.receipt.owner.parentSessionId !== spec.owner.parentSessionId) {
            await native.cancel("shutdown")
            throw new Error("native owner mismatch")
          }
          const receipt = Object.freeze({ ...native.receipt, backendId: "windows-acl-legacy",
            policyFingerprint: policy.fingerprint, assurance: "unverified" as const,
            owner: Object.freeze({ ...policy.owner }) })
          return Object.freeze({
            receipt, pid: native.pid, io: native.io, runner,
            rootExited: native.rootExited, get settled() { return native.settled },
            cancel: (reason: StopReason) => native.cancel(reason), release: () => native.release(),
          }) satisfies TransportExecutionHandle
        },
        rollback: () => nativePrepared.rollback(),
      }
    },
    async dispose() { disposed = true; await provider.dispose?.() },
  }
}
