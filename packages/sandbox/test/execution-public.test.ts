import { expect, expectTypeOf, it } from "vitest"
import { checkBackendRequirements } from "@i-harness/sandbox"
import type {
  ExecutionTransport, ExecutionLifetime, BackendAssurance, StopReason, ExecutionOwner,
  BackendProbe, BackendRequirements, BackendDecision, ProcessSpec, AuthorityState,
  CompiledSandboxPolicy, ExecutionReceipt, RootExit, ExecutionSettlement,
  ExecutionHandle, PreparedExecution, ExecutionBackend, SandboxMode, SandboxProvider,
  ExecutionIo,
} from "@i-harness/sandbox"

it("exposes platform-neutral execution contracts to package consumers", () => {
  expectTypeOf<ExecutionTransport>().toEqualTypeOf<"pipe" | "pty">()
  expectTypeOf<ExecutionLifetime>().toEqualTypeOf<"complete-tree" | "retain-tree">()
  expectTypeOf<BackendAssurance>().toEqualTypeOf<"verified" | "experimental" | "unverified">()
  expectTypeOf<StopReason>().toEqualTypeOf<"cancelled" | "timeout" | "output-limit" | "authority-revoked" | "shutdown">()
  expectTypeOf<CompiledSandboxPolicy["mode"]>().toEqualTypeOf<SandboxMode>()
  expectTypeOf<CompiledSandboxPolicy["owner"]>().toEqualTypeOf<Readonly<ExecutionOwner>>()
  expectTypeOf<CompiledSandboxPolicy["authorityRoots"]>().toEqualTypeOf<readonly string[]>()
  const readOnlyPolicy: CompiledSandboxPolicy = {
    mode: "read-only", owner: { sessionId: "consumer" }, authorityRevision: "1",
    authorityKind: "bound", primaryRoot: "/primary", readable: "caller",
    authorityRoots: ["/primary", "/secondary"], writeRoots: [], referenceRoots: [], fingerprint: "fixture",
  }
  expectTypeOf(readOnlyPolicy.authorityRoots).toEqualTypeOf<readonly string[]>()
  expectTypeOf<ExecutionReceipt["owner"]>().toEqualTypeOf<Readonly<ExecutionOwner>>()
  expectTypeOf<ExecutionHandle["rootExited"]>().toEqualTypeOf<Promise<RootExit>>()
  expectTypeOf<RootExit["observationError"]>().toEqualTypeOf<string | undefined>()
  const unknownRoot: RootExit = { exitCode: null, observationError: "root status unavailable" }
  expect(unknownRoot).toEqual({ exitCode: null, observationError: "root status unavailable" })
  expectTypeOf<ExecutionHandle["settled"]>().toEqualTypeOf<Promise<ExecutionSettlement>>()
  expectTypeOf<ReturnType<NonNullable<ExecutionIo["diagnostics"]>>>().toEqualTypeOf<{ outputAbandoned: boolean; discardedOutputBytes: number }>()
  expectTypeOf<ExecutionHandle["cancel"]>().parameter(0).toEqualTypeOf<StopReason>()
  expectTypeOf<ExecutionHandle["release"]>().returns.toEqualTypeOf<Promise<ExecutionSettlement>>()
  expectTypeOf<PreparedExecution["commit"]>().parameter(0).toEqualTypeOf<() => void>()
  expectTypeOf<PreparedExecution["commit"]>().returns.toEqualTypeOf<Promise<ExecutionHandle>>()
  expectTypeOf<PreparedExecution["rollback"]>().returns.toEqualTypeOf<Promise<void>>()
  expectTypeOf<ExecutionBackend["probe"]>().returns.toEqualTypeOf<Promise<BackendProbe>>()
  expectTypeOf<ExecutionBackend["prepare"]>().parameters.toEqualTypeOf<[ProcessSpec, CompiledSandboxPolicy, AbortSignal?]>()
  expectTypeOf<ExecutionBackend["prepare"]>().returns.toEqualTypeOf<Promise<PreparedExecution>>()
  expectTypeOf<typeof checkBackendRequirements>().parameters.toEqualTypeOf<[BackendProbe, BackendRequirements]>()
  expectTypeOf<typeof checkBackendRequirements>().returns.toEqualTypeOf<BackendDecision>()
  expectTypeOf<AuthorityState["kind"]>().toEqualTypeOf<"unbound" | "bound" | "revoked" | "unavailable">()
  expectTypeOf<SandboxProvider["confine"]>().parameter(0).toEqualTypeOf<readonly string[]>()
  expect(checkBackendRequirements).toBeTypeOf("function")
})
