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
const state = vi.hoisted(() => ({ creates: 0, disposals: 0, fail: true, registry: undefined as import("@i-harness/hooks").HookRegistry | undefined }))
vi.mock("@i-harness/hooks", async load => {
  const original = await load<typeof import("@i-harness/hooks")>()
  return { ...original, async createExecutionHookRegistry(...args: Parameters<typeof original.createExecutionHookRegistry>) {
    const registry = await original.createExecutionHookRegistry(...args), index = state.creates++
    if (index === 1) { state.registry = registry; const dispose = registry.dispose.bind(registry); registry.dispose = async () => { state.disposals++; if (state.fail) throw false; await dispose() } }
    return registry
  } }
})
import { createHookTrustStore, resolveHookTrustPath } from "@i-harness/hooks"
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it("continues withdrawing another unreadable registry while failed-start cleanup remains owed", async () => {
  state.creates = 0; state.disposals = 0; state.fail = true; state.registry = undefined
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-debt-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    const execution = await acquireManagedExecution(coordinator, "s"), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution)
    const live = join(root, "live.json"), failed = join(root, "failed.json"), liveScript = join(root, "live.cjs"), failedScript = join(root, "failed.cjs"), log = join(root, "calls.txt")
    const body = `require('fs').appendFileSync(${JSON.stringify(log)},'called\\n')`, unapproved = "// not approved\n"
    await writeFile(liveScript, body); await writeFile(failedScript, unapproved)
    const hash = (text: string) => createHash("sha256").update(text).digest("hex")
    await writeFile(live, JSON.stringify({ version: 1, handlers: [{ id: "prompt", event: "prompt/submit", type: "command", command: { cmd: process.execPath, args: [liveScript] }, trust: { script: liveScript, sha256: hash(body) } }] }))
    await writeFile(failed, JSON.stringify({ version: 1, handlers: [{ id: "start", event: "session/start", type: "command", command: { cmd: process.execPath, args: [failedScript] }, trust: { script: failedScript, sha256: hash(unapproved) } }] }))
    createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256: hash(body), script: liveScript, handlerId: "live" })
    let failReport = true
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => { if (failReport) throw undefined } })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [live, failed], commandDescriptors: [] }
    try {
      let first: unknown; try { await mount.update(inputs) } catch (error) { first = error }
      expect((first as AggregateError).errors).toEqual([undefined, false])
      const original = state.registry
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "before", domain: origin.domain, promptSubmission: true })
      failReport = false; await rm(live)
      let second: unknown; try { await mount.update(inputs) } catch (error) { second = error }
      expect(second).toBeInstanceOf(AggregateError)
      expect((second as AggregateError).errors.slice(0, 2)).toEqual([undefined, false])
      expect(state.registry).toBe(original); expect(state.creates).toBe(2); expect(state.disposals).toBe(2)
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "after", domain: origin.domain, promptSubmission: true })
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
      state.fail = false; await mount.close(); expect(state.disposals).toBe(3)
    } finally { state.fail = false; await mount.close(); await execution.close() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
