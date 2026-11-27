import { expect, it, vi } from "vitest"
import type { ExecService, SupervisedExecution } from "@i-harness/exec"
import { createTerminalService } from "../src/service.ts"

function fixture() {
  const queued: Uint8Array[] = []
  let wake: (() => void) | undefined
  let ended = false
  const root = Promise.withResolvers<{ exitCode: number }>()
  const finishOutput = () => { ended = true; wake?.() }
  const settled = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
  const handle = {
    pid: 42,
    rootExited: root.promise,
    settled: new Promise(() => {}),
    io: { output: { async *[Symbol.asyncIterator]() {
      while (!ended || queued.length) {
        if (!queued.length) await new Promise<void>(resolve => { wake = resolve })
        while (queued.length) yield { channel: "pty" as const, data: queued.shift()! }
      }
    } }, write: async () => {}, endInput: async () => {}, resize: async () => {} },
  }
  const exec = {
    launchTransport: async () => ({ id: "execution-fixture", policy: { owner: { sessionId: "standalone-exec" } }, handle }) as unknown as SupervisedExecution,
    cancelExecution: async () => { finishOutput(); return settled },
  } as unknown as ExecService
  return { exec, exit: () => root.resolve({ exitCode: 0 }), finishOutput, push(data: string | Uint8Array) { queued.push(Buffer.from(data)); wake?.() } }
}

it("keeps a late-refused managed PTY private and settles it before a new launch", async () => {
  const sources = new Map<string, ReturnType<typeof fixture>>()
  const cancelled: string[] = []
  let expired = true, allowCleanup = false
  const invocation = Object.freeze({})
  const exec: ExecService = {
    ...fixture().exec,
    launchTransport: async () => { throw new Error("Managed terminal must use its prepared transport") },
    cancelExecution: async (id: string) => {
      cancelled.push(id)
      if (!allowCleanup) return { kind: "incomplete" as const, phase: "release" as const, detail: "controlled cleanup failure" }
      return sources.get(id)!.exec.cancelExecution(id, "cancelled")
    },
  }
  const service = createTerminalService(exec, {
    assertInvocation(candidate) { if (candidate !== invocation) throw Error("foreign fixture invocation") },
    async launch(request, check) {
      check()
      const id = "native-" + (sources.size + 1)
      const source = fixture()
      sources.set(id, source)
      return { ...await source.exec.launchTransport(request), id }
    },
    assertPolicy() { if (expired) throw Error("retired before PTY publication") },
  })
  const open = () => service.open({ command: "fixture", sandbox: { mode: "danger-full-access", workspaceRoot: "." } }, { invocation })
  try {
    await expect(open()).rejects.toThrow("Terminal admission cleanup incomplete")
    expect(service.list()).toEqual([])
    expect(service.hasActiveWork()).toBe(true)
    expect(cancelled).toEqual(["native-1"])

    expired = false
    await expect(open()).rejects.toThrow("Terminal cleanup incomplete")
    expect(service.list()).toEqual([])
    expect(sources.size).toBe(1)
    allowCleanup = true
    const { id } = await open()
    expect(cancelled).toEqual(["native-1", "native-1", "native-1"])
    expect(service.list()).toMatchObject([{ id }])
    expect(sources.size).toBe(2)
  } finally {
    allowCleanup = true
    await service.dispose()
  }
})

it("reads bounded UTF-16 windows across frames and preserves zero-length and future cursors", async () => {
  const source = fixture(), service = createTerminalService(source.exec)
  const { id } = await service.open({ command: "fixture", rawOutput: true })
  const chunks = ["1".repeat(4500), "🐋".repeat(2250), "尾聲"]
  for (const text of chunks) source.push(text)
  const combined = chunks.join("")
  try {
    await vi.waitFor(() => expect(service.read(id, { offset: 9000 }).data).toBe("尾聲"))
    for (const offset of [0, 4499, 4501, 8999, 9000, combined.length, 12000]) {
      for (const maxBytes of [0, 1, 3, 4502, 15000]) {
        const data = combined.slice(offset, offset + maxBytes)
        expect(service.read(id, { offset, maxBytes })).toMatchObject({ data,
          nextOffset: offset + data.length, truncated: offset + data.length < combined.length })
      }
    }
  } finally { await service.dispose() }
})

it("keeps the output readable between root exit and the final decoded frame", async () => {
  const source = fixture(), service = createTerminalService(source.exec)
  const { id } = await service.open({ command: "fixture" })
  try {
    source.exit()
    await vi.waitFor(() => expect(service.read(id)).toMatchObject({ data: "", status: "exited", outputPending: true, exitCode: 0 }))
    source.push("tail\r")
    source.finishOutput()
    await vi.waitFor(() => expect(service.read(id)).toMatchObject({ data: "tail\r", nextOffset: 5 }))
    expect(service.read(id, { offset: 5 }).outputPending).toBeUndefined()
  } finally { await service.dispose() }
})

it("keeps absolute cursors after trimming a full output ring", async () => {
  const source = fixture()
  const service = createTerminalService(source.exec)
  const terminal = await service.open({ command: "fixture" })
  source.push("a".repeat(1000001))
  await vi.waitFor(() => expect(service.read(terminal.id, { maxBytes: 1000000 }).data.length).toBe(1000000))
  const first = service.read(terminal.id, { offset: 0, maxBytes: 1000000 })
  expect(first.nextOffset).toBe(1000001)
  expect(first.dropped).toBe(true)
  source.push("NEXT")
  await vi.waitFor(() => expect(service.read(terminal.id, { offset: first.nextOffset }).data).toBe("NEXT"))
  await service.dispose()
})

it("preserves raw control sequences for a desktop terminal", async () => {
  const source = fixture()
  const service = createTerminalService(source.exec)
  const terminal = await service.open({ command: "fixture", rawOutput: true })
  source.push("line\r\n\x1b[2J")
  await vi.waitFor(() => expect(service.read(terminal.id).data).toBe("line\r\n\x1b[2J"))
  await service.dispose()
})

it("decodes UTF-8 and normalizes CRLF across native output frames", async () => {
  const source = fixture()
  const service = createTerminalService(source.exec)
  const terminal = await service.open({ command: "fixture" })
  const character = Buffer.from("界")
  source.push(character.subarray(0, 1))
  source.push(character.subarray(1))
  source.push("line\r")
  source.push("\n")
  await vi.waitFor(() => expect(service.read(terminal.id).data).toBe("界line\n"))
  await service.dispose()
})
