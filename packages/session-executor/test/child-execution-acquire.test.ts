import { expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { assertManagedExecutionSession } from "@i-harness/core-session/internal/execution"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/backend-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { createSessionService } from "../src/service.ts"
import { acquireChildManagedExecution, createChildExecutionDomain } from "../src/host-managed-execution.ts"

it("acquires a child session's own managed execution attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-child-exec-"))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "test-mock", mockScript: [] })
  try {
    await coordinator.create({ sessionId: "child" })
    const child = await acquireChildManagedExecution(service, "child")
    expect(() => assertManagedExecutionSession(child.execution.identity, child.execution.owner, "child")).not.toThrow()
    expect(() => assertManagedExecutionSession(child.execution.identity, child.execution.owner, "other")).toThrow()
    const domain = createChildExecutionDomain(child.execution, createContext())
    expect(domain.sessionId).toBe("child")
    expect(() => domain.assertCurrent()).not.toThrow()
    await child.release()
  } finally {
    await service.close()
    await coordinator.close()
  }
})
