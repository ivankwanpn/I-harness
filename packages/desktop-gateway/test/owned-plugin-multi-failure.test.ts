import { expect, it, vi } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createContext, captureExecutionHookChannel } from "@i-harness/core-plugin"
import { createManagedAgentModelOriginOwner } from "../../core-agent/src/tool-batch/model-origin.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { acquireManagedExecution } from "../../session-persistence/src/execution-internal.ts"
const state = vi.hoisted(() => ({ creates: 0, failRefresh: false }))
vi.mock("@i-harness/hooks", async load => {
  const original = await load<typeof import("@i-harness/hooks")>()
  return { ...original, async createExecutionHookRegistry(...args: Parameters<typeof original.createExecutionHookRegistry>) {
    const registry = await original.createExecutionHookRegistry(...args), index = state.creates++
    if (index === 0) { const refresh = registry.refreshTrust.bind(registry); registry.refreshTrust = async approvals => { if (state.failRefresh) throw new Error("controlled refresh failure"); await refresh(approvals) } }
    return registry
  } }
})
import { createHookTrustStore, resolveHookTrustPath } from "@i-harness/hooks"
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it.each([false, true])("reports and dismounts an unreadable hook even if refresh fails (report throws: %s)", async reportThrows => {
  state.creates = 0; state.failRefresh = false
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-multi-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    const execution = await acquireManagedExecution(coordinator, "s"), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution)
    const first = join(root, "first.json"), second = join(root, "second.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt"), body = `require('fs').appendFileSync(${JSON.stringify(log)},'called\\n')`
    await writeFile(script, body); const sha256 = createHash("sha256").update(body).digest("hex")
    await writeFile(first, JSON.stringify({ version: 1, handlers: [] }))
    await writeFile(second, JSON.stringify({ version: 1, handlers: [{ id: "prompt", event: "prompt/submit", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } }] }))
    createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256, script, handlerId: "fixture" })
    const reports: string[][] = []; let updating = false
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: rows => { reports.push(rows); if (updating && reportThrows) throw false } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [first, second], commandDescriptors: [] }
    try {
      await mount.update(inputs); await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "before", domain: origin.domain, promptSubmission: true })
      state.failRefresh = true; updating = true; await rm(second)
      let failure: unknown; try { await mount.update(inputs) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(reportThrows ? 3 : 2)
      expect((failure as AggregateError).errors[1]).toMatchObject({ message: "controlled refresh failure" })
      if (reportThrows) expect((failure as AggregateError).errors[2]).toBe(false)
      expect(reports.at(-1)?.some(row => row.includes(`Hooks ${second}:`))).toBe(true)
      expect(reports.at(-1)?.some(row => row.includes(`Hook trust ${first}:`))).toBe(true)
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "after", domain: origin.domain, promptSubmission: true })
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
    } finally { state.failRefresh = false; updating = false; await mount.close(); await execution.close() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
