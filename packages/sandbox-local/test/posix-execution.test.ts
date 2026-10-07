import { describe, expect, it } from "vitest"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createPosixExecutionBackend } from "../src/index.ts"

describe("POSIX execution driver", () => {
  it.skipIf(process.platform === "linux")("refuses POSIX launch on a non-POSIX host", async () => {
    const backend = createPosixExecutionBackend()
    expect((await backend.probe()).availability).toBe("unavailable")
  })
  it.skipIf(process.platform !== "linux")("runs a pipe with exact environment, cwd, and owned output", async () => {
    const backend = createPosixExecutionBackend()
    const policy = compileExecutionPolicy({ mode: "danger-full-access", owner: { sessionId: "owner" },
      authority: { kind: "unbound", revision: "r1", workspaceRoot: process.cwd() } })
    const prepared = await backend.prepare({ argv: [process.execPath, "-e",
      "process.stdout.write(JSON.stringify({ cwd: process.cwd(), keys: Object.keys(process.env).sort(), marker: process.env.MARKER }))"],
      cwd: process.cwd(), env: { MARKER: "exact" }, owner: { sessionId: "owner" },
      transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" }, policy)
    const handle = await prepared.commit(() => {})
    const chunks: Uint8Array[] = []
    for await (const frame of handle.io.output) {
      expect(frame.channel).toBe("stdout")
      chunks.push(frame.data)
    }
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ cwd: process.cwd(), keys: ["MARKER"], marker: "exact" })
    expect(await handle.release()).toMatchObject({ kind: "settled", root: { exitCode: 0 }, treeEmpty: true })
    await backend.dispose()
  })

  it.skipIf(process.platform !== "linux")("refuses PTY environment injection and runs with caller-declared PWD and TERM", async () => {
    const backend = createPosixExecutionBackend()
    const policy = compileExecutionPolicy({ mode: "danger-full-access", owner: { sessionId: "owner" },
      authority: { kind: "unbound", revision: "r1", workspaceRoot: process.cwd() } })
    const base = { argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      cwd: process.cwd(), owner: { sessionId: "owner" }, transport: "pty" as const,
      lifetime: "complete-tree" as const, argumentEncoding: "crt" as const, pty: { cols: 80, rows: 24 } }
    await expect(backend.prepare({ ...base, env: {} }, policy)).rejects.toThrow(/PWD=cwd and TERM/)
    const prepared = await backend.prepare({ ...base, env: { PWD: process.cwd(), TERM: "xterm-256color", MARKER: "exact" } }, policy)
    const handle = await prepared.commit(() => {})
    const chunks: Uint8Array[] = []
    for await (const frame of handle.io.output) { expect(frame.channel).toBe("pty"); chunks.push(frame.data) }
    expect(JSON.parse(Buffer.concat(chunks).toString().trim())).toEqual(["MARKER", "PWD", "TERM"])
    expect(await handle.release()).toMatchObject({ kind: "settled", root: { exitCode: 0 } })
    await backend.dispose()
  })
})
