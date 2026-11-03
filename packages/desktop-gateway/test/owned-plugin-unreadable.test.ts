import { expect, it } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createContext, captureExecutionHookChannel } from "@i-harness/core-plugin"
import { createManagedAgentModelOriginOwner } from "../../core-agent/src/tool-batch/model-origin.ts"
import { createHookTrustStore, resolveHookTrustPath } from "@i-harness/hooks"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { composeJsonlTaskTransitionCoordinator } from "../../session-persistence-jsonl/src/task-document-factory.ts"
import { taskDocumentStorageContract } from "../../subagent/src/task/storage-contract.ts"
import { acquireManagedExecution } from "../../session-persistence/src/execution-internal.ts"
import { createOwnedPluginMount } from "../src/owned-plugin-mount.ts"

it("withdraws the old native hook when its configuration becomes unreadable", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-unreadable-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    const execution = await acquireManagedExecution(coordinator, "s"), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution)
    const path = join(root, "native.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt"), body = `require('fs').appendFileSync(${JSON.stringify(log)},'called\\n')`
    await writeFile(script, body); const sha256 = createHash("sha256").update(body).digest("hex")
    await writeFile(path, JSON.stringify({ version: 1, handlers: [{ id: "prompt", event: "prompt/submit", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } }] }))
    createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256, script, handlerId: "fixture" })
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => {} })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    try {
      await mount.update(inputs)
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "before", domain: origin.domain, promptSubmission: true })
      await rm(path)
      await expect(mount.update(inputs)).rejects.toThrow()
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "after", domain: origin.domain, promptSubmission: true })
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
    } finally { await mount.close(); await execution.close() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("retains failed unreadable-hook dismount and revokes its authority until retry", async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, "plugin-unreadable-held-"))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: "s" })
    const execution = await acquireManagedExecution(coordinator, "s"), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution)
    const path = join(root, "native.json"), script = join(root, "hook.cjs"), log = join(root, "events.txt"), body = `require('fs').appendFileSync(${JSON.stringify(log)},'called\\n')`
    await writeFile(script, body); const sha256 = createHash("sha256").update(body).digest("hex")
    const config = JSON.stringify({ version: 1, handlers: [{ id: "prompt", event: "prompt/submit", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256 } }] })
    await writeFile(path, config); createHookTrustStore(resolveHookTrustPath(root)).approve({ sha256, script, handlerId: "fixture" })
    const unmount = ctx.unmount.bind(ctx); let calls = 0
    ctx.unmount = async name => { if (++calls === 1) throw false; await unmount(name) }
    const mount = createOwnedPluginMount({ ctx, sessionId: "s", startSource: "startup", configDir: root, workspace: root, report: () => {} })
    const inputs = { skillDirs: [], mcpServerConfigs: {}, agentDescriptors: [], hookConfigs: [path], commandDescriptors: [] }
    try {
      await mount.update(inputs)
      await captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "before", domain: origin.domain, promptSubmission: true })
      await rm(path)
      let failure: unknown; try { await mount.update(inputs) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors[1]).toBe(false)
      await writeFile(path, config)
      expect(mount.hookAuthority([path])).toBeUndefined()
      await expect(captureExecutionHookChannel(ctx).emit("agent/pre-step", { task: "after", domain: origin.domain, promptSubmission: true })).rejects.toThrow()
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1)
      await mount.close(); expect(calls).toBe(2)
    } finally { await mount.close(); await execution.close() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
