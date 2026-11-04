import { expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import type { ExecExecutionHost } from "@i-harness/exec"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { createSessionService } from "../src/service.ts"
import { acquireChildManagedExecution } from "../src/host-managed-execution.ts"
import { mountChildShellTools } from "../src/child-shell.ts"

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