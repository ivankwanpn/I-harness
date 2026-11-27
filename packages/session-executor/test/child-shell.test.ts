import { expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createNondurableFactOwner, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { isOriginalLocalExecTool } from "@i-harness/core-tools/internal/scoped-exec-origin"
import type { ExecExecutionHost, NativeExecService } from "@i-harness/exec"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { createSessionService } from "../src/service.ts"
import { acquireChildManagedExecution } from "../src/host-managed-execution.ts"
import { mountChildShellTools } from "../src/child-shell.ts"
import { createAssemblyExecutionRuntime } from "../src/execution-runtime.ts"

const unusedHost = {
  selectBackend() { throw new Error("selectBackend is not used by mount") },
  resolvePolicy() { throw new Error("resolvePolicy is not used by mount") },
  validateAuthority() { throw new Error("validateAuthority is not used by mount") },
} as unknown as ExecExecutionHost

it("mounts child-owned shell tools and disposes the execution once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-child-shell-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "test-mock", mockScript: [] })
  try {
    await coordinator.create({ sessionId: "child" })
    const acquired = await acquireChildManagedExecution(service, "child")
    const ctx = createContext(), tools = createToolRegistry(ctx)
    let released = 0
    const mount = mountChildShellTools({ ctx, tools, workspace: root, execution: acquired.execution, host: unusedHost, release: async () => { released++; await acquired.release() } })
    expect(tools.get("bash")).toBeDefined()
    expect(tools.get("pwsh")).toBeDefined()
    ctx.scope.unmount()
    await mount.dispose()
    await mount.dispose()
    expect(released).toBe(1)
  } finally {
    await service.close()
    await coordinator.close()
  }
})

it("joins child Shell disposal and retries only the unfinished cleanup stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-child-shell-retry-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "test-mock", mockScript: [] })
  try {
    await coordinator.create({ sessionId: "child" })
    const acquired = await acquireChildManagedExecution(service, "child")
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const processStarted = Promise.withResolvers<void>(), processGate = Promise.withResolvers<void>()
    const releaseStarted = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>()
    const processError = new Error("original process cleanup incomplete")
    const releaseError = new Error("original execution release incomplete")
    const closeHost = vi.fn(async () => {
      if (closeHost.mock.calls.length === 1) {
        processStarted.resolve()
        await processGate.promise
        throw processError
      }
    })
    const release = vi.fn(async () => {
      if (release.mock.calls.length === 1) {
        releaseStarted.resolve()
        await releaseGate.promise
        throw releaseError
      }
      await acquired.release()
    })
    const mount = mountChildShellTools({ ctx, tools, workspace: root, execution: acquired.execution,
      host: { ...unusedHost, dispose: closeHost }, release })
    const stopProcess = vi.spyOn(ctx.services.get<NativeExecService>("exec/service"), "dispose")
    try {
      const first = mount.dispose()
      const processOutcome = first.catch(error => error)
      await processStarted.promise
      expect(mount.dispose()).toBe(first)
      expect(release).not.toHaveBeenCalled()
      processGate.resolve()
      expect(await processOutcome).toBe(processError)
      expect(stopProcess).toHaveBeenCalledTimes(1)
      expect(release).not.toHaveBeenCalled()

      const second = mount.dispose()
      const releaseOutcome = second.catch(error => error)
      expect(second).not.toBe(first)
      await releaseStarted.promise
      expect(mount.dispose()).toBe(second)
      expect(stopProcess).toHaveBeenCalledTimes(2)
      releaseGate.resolve()
      expect(await releaseOutcome).toBe(releaseError)

      const complete = mount.dispose()
      await complete
      expect(mount.dispose()).toBe(complete)
      expect(stopProcess).toHaveBeenCalledTimes(2)
      expect(closeHost).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledTimes(2)
    } finally {
      processGate.resolve()
      releaseGate.resolve()
      await mount.dispose().catch(() => {})
      await acquired.release()
    }
  } finally { await service.close(); await coordinator.close() }
})

it.each([true, false])("mounts only declared search when the child has its own standing host (%s)", async native => {
  const root = mkdtempSync(join(tmpdir(), "ih-child-search-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "test-mock", mockScript: [] })
  try {
    await coordinator.create({ sessionId: "child" })
    const acquired = await acquireChildManagedExecution(service, "child")
    const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
    const host = native ? createAssemblyExecutionRuntime({
      owner: { sessionId: "child" }, managedExecution: acquired.execution,
      authority: () => ({ kind: "unbound", revision: "child-root", workspaceRoot: root }),
      standing: () => ({ mode: "read-only", generation: "child" }),
    }).execution : unusedHost
    const mount = mountChildShellTools({ ctx, tools, workspace: root, execution: acquired.execution, host,
      allowedTools: ["grep"], isToolAllowed: name => name === "grep",
      searchOwner: { session, factOwner: createNondurableFactOwner(session) }, release: acquired.release })
    try {
      expect(tools.deferredSearchIndex().map(tool => tool.name)).toEqual(native ? ["grep"] : [])
      expect(tools.get("glob")).toBeUndefined()
      for (const name of ["shell", "bash", "pwsh"]) expect(tools.get(name)).toBeUndefined()
      if (native) {
        const grep = tools.get("grep")!
        expect(isOriginalLocalExecTool(grep)).toBe(true)
        await expect(grep.execute({ pattern: "test" }, {})).rejects.toThrow("Original prepared search invocation required")
      }
    } finally { await mount.dispose() }
  } finally { await service.close(); await coordinator.close() }
})
