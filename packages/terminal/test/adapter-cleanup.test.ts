import { expect, it, vi } from "vitest"
import { currentExecCaller, withExecCallerScope, type ExecService, type SupervisedExecution } from "@i-harness/exec"
import { createTerminalService } from "../src/service.ts"

it("keeps the owner, view and bytes after incomplete cleanup, then retries the same execution", async () => {
  const owner = Object.freeze({ sessionId: "owner-a" })
  const incomplete = { kind: "incomplete" as const, phase: "tree" as const, detail: "descendant still attached" }
  const settled = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
  let releaseOutput: (() => void) | undefined
  const handle = {
    pid: 123, rootExited: Promise.resolve({ exitCode: 0 }), settled: Promise.resolve(incomplete),
    io: { output: { async *[Symbol.asyncIterator]() {
      yield { channel: "pty" as const, data: Buffer.from("before-retry") }
      await new Promise<void>(resolve => { releaseOutput = resolve })
    } }, write: async () => {}, endInput: async () => {}, resize: async () => {} },
  }
  let attempts = 0
  const callers: Array<string | undefined> = []
  const launchTransport = vi.fn(async () => ({ id: "same-execution", policy: { owner }, handle }) as unknown as SupervisedExecution)
  const cancelExecution = vi.fn(async () => {
    callers.push(currentExecCaller()?.sessionId)
    if (++attempts === 1) return incomplete
    releaseOutput?.()
    return settled
  })
  const service = createTerminalService({ launchTransport, cancelExecution } as unknown as ExecService)
  const terminal = await withExecCallerScope(owner, () => service.open({ command: "fixture" }, { sessionId: owner.sessionId }))
  await vi.waitFor(() => expect(service.read(terminal.id, { sessionId: owner.sessionId }).data).toBe("before-retry"))
  await expect(service.close(terminal.id, { sessionId: owner.sessionId })).rejects.toThrow(/incomplete/)
  expect(service.list()).toEqual([expect.objectContaining({ id: terminal.id, ownerSessionId: owner.sessionId, status: "exited", cleanupDetail: expect.stringContaining("descendant") })])
  expect(service.read(terminal.id, { sessionId: owner.sessionId }).data).toBe("before-retry")
  await expect(service.close(terminal.id, { sessionId: "owner-b" })).rejects.toThrow(/OWNER_MISMATCH/)
  expect(await service.close(terminal.id, { sessionId: owner.sessionId })).toMatchObject({ settlement: settled })
  expect(service.list()).toEqual([])
  expect(launchTransport).toHaveBeenCalledOnce()
  expect(cancelExecution).toHaveBeenCalledTimes(2)
  expect(callers).toEqual([owner.sessionId, owner.sessionId])
})

it("failed disposal preserves its view for an explicit retry", async () => {
  const owner = Object.freeze({ sessionId: "owner-a" })
  const incomplete = { kind: "incomplete" as const, phase: "release" as const, detail: "still in use" }
  const settled = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
  let finishOutput: (() => void) | undefined
  const handle = { pid: 44, rootExited: Promise.resolve({ exitCode: 0 }), settled: Promise.resolve(incomplete),
    io: { output: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finishOutput = resolve }) } }, write: async () => {}, endInput: async () => {} } }
  let attempts = 0
  const exec = { launchTransport: async () => ({ id: "same-execution", policy: { owner }, handle }) as unknown as SupervisedExecution,
    cancelExecution: async () => { if (++attempts === 1) return incomplete; finishOutput?.(); return settled } } as unknown as ExecService
  const service = createTerminalService(exec)
  const terminal = await withExecCallerScope(owner, () => service.open({ command: "fixture" }, { sessionId: owner.sessionId }))
  await expect(service.dispose()).rejects.toThrow(/incomplete/)
  expect(service.list()).toEqual([expect.objectContaining({ id: terminal.id, cleanupDetail: expect.stringContaining("still in use") })])
  await expect(service.dispose()).resolves.toBeUndefined()
  expect(service.list()).toEqual([])
  expect(attempts).toBe(2)
})

it("does not expose a late committed PTY after disposal and retains exact launch facts", async () => {
  let commit!: (execution: SupervisedExecution) => void
  let request: unknown
  const admission = new Promise<SupervisedExecution>(resolve => { commit = resolve })
  const cancelExecution = vi.fn(async () => ({ kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }))
  const exec = { launchTransport: (input: unknown) => { request = input; return admission }, cancelExecution } as unknown as ExecService
  const service = createTerminalService(exec)
  const pending = service.open({ command: "fixture", args: ["literal value"], env: {}, rawOutput: true, cols: 99, rows: 41 })
  void pending.catch(() => {})
  expect(service.list()).toEqual([])
  expect(request).toMatchObject({ argv: ["fixture", "literal value"], env: {}, transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt", pty: { cols: 99, rows: 41 } })
  const disposal = service.dispose()
  let acknowledged = false
  void disposal.then(() => { acknowledged = true })
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  expect((request as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true)
  const handle = { pid: 7, rootExited: Promise.resolve({ exitCode: 0 }), settled: Promise.resolve({ kind: "settled", root: { exitCode: 0 } }),
    io: { output: { async *[Symbol.asyncIterator]() {} }, write: async () => {}, endInput: async () => {} } }
  commit({ id: "committed-late", policy: { owner: { sessionId: "standalone-exec" } }, handle } as unknown as SupervisedExecution)
  await expect(pending).rejects.toThrow(/disposed during admission/)
  await disposal
  expect(acknowledged).toBe(true)
  expect(cancelExecution).toHaveBeenCalledWith("committed-late", "cancelled")
  expect(service.list()).toEqual([])
})

it("writes large UTF-8 input in sequential native frames without changing bytes", async () => {
  const frames: Buffer[] = []
  const handle = { pid: 5, rootExited: new Promise(() => {}), settled: new Promise(() => {}),
    io: { output: { async *[Symbol.asyncIterator]() {} }, write: async (bytes: Uint8Array) => { frames.push(Buffer.from(bytes)) }, endInput: async () => {} } }
  const exec = { launchTransport: async () => ({ id: "byte-frame", policy: { owner: { sessionId: "standalone-exec" }, mode: "danger-full-access" }, handle }) as unknown as SupervisedExecution } as unknown as ExecService
  const service = createTerminalService(exec)
  const terminal = await service.open({ command: "fixture" })
  const input = "界".repeat(14_000)
  await service.send(terminal.id, input)
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.every(frame => frame.length <= 16_384)).toBe(true)
  expect(Buffer.concat(frames)).toEqual(Buffer.from(input))
})

it("failed cancellation of a late committed PTY rejects disposal and keeps retryable ownership", async () => {
  let commit!: (execution: SupervisedExecution) => void
  const admission = new Promise<SupervisedExecution>(resolve => { commit = resolve })
  const incomplete = { kind: "incomplete" as const, phase: "tree" as const, detail: "late child attached" }
  const settled = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
  let finishOutput: (() => void) | undefined
  const handle = { pid: 18, rootExited: Promise.resolve({ exitCode: 0 }), settled: Promise.resolve(incomplete),
    io: { output: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finishOutput = resolve }) } }, write: async () => {}, endInput: async () => {} } }
  let attempts = 0
  const exec = { launchTransport: () => admission,
    cancelExecution: async () => { if (++attempts === 1) return incomplete; finishOutput?.(); return settled } } as unknown as ExecService
  const service = createTerminalService(exec)
  const pending = service.open({ command: "late-fixture" })
  void pending.catch(() => {})
  const disposal = service.dispose()
  commit({ id: "late", policy: { owner: { sessionId: "standalone-exec" } }, handle } as unknown as SupervisedExecution)
  await expect(pending).rejects.toThrow(/incomplete/)
  await expect(disposal).rejects.toThrow(/incomplete/)
  expect(service.list()).toEqual([expect.objectContaining({ command: "late-fixture", ownerSessionId: "standalone-exec", cleanupDetail: expect.stringContaining("late child attached") })])
  await service.dispose()
  expect(service.list()).toEqual([])
  expect(attempts).toBe(2)
})
