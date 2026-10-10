import { expect, it, vi } from "vitest"
import type { ExecService, SupervisedExecution } from "@i-harness/exec"
import { createTerminalService } from "../src/service.ts"

function fixture() {
  const queued: Uint8Array[] = []
  let wake: (() => void) | undefined
  let ended = false
  const settled = { kind: "settled" as const, root: { exitCode: 0 }, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }
  const handle = {
    pid: 42,
    rootExited: new Promise(() => {}),
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
    cancelExecution: async () => { ended = true; wake?.(); return settled },
  } as unknown as ExecService
  return { exec, push(data: string | Uint8Array) { queued.push(Buffer.from(data)); wake?.() } }
}

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
