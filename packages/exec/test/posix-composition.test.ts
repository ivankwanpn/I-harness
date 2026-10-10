import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import { compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createExecService } from "../src/service.ts"
import { createPosixExecutionBackend } from "../../sandbox-local/src/posix-execution.ts"

const fixture = vi.hoisted(() => ({ children: [] as any[], argv: [] as string[][] }))
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), platform: () => "linux" }))
vi.mock("../../sandbox-local/src/profiles.ts", async importOriginal => ({ ...await importOriginal<object>(), probeBwrap: () => true }))
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: (file: string, args: string[]) => {
  const child = Object.assign(new EventEmitter(), { pid: 43210, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  fixture.children.push(child); fixture.argv.push([file, ...args])
  queueMicrotask(() => child.emit("spawn"))
  return child
} }))
afterEach(() => { vi.restoreAllMocks(); fixture.children.length = 0; fixture.argv.length = 0 })

// OS seams are simulated on Windows; these assert composition, not native POSIX qualification.
function setup(mode: "danger-full-access" | "workspace-write" = "danger-full-access") {
  const backend = createPosixExecutionBackend()
  const exec = createExecService({ execution: {
    defaultOwner: { sessionId: "posix-owner" }, selectBackend: () => backend,
    resolvePolicy: owner => compileExecutionPolicy({ mode, owner, authority: { kind: "unbound", revision: "posix-test", workspaceRoot: process.cwd() } }),
    validateAuthority: () => {}, dispose: () => backend.dispose(),
  } })
  return { backend, exec }
}
function endChild() {
  const child = fixture.children[0]!
  child.stdout.end(); child.stderr.end(); child.emit("close")
}
it.each(["danger-full-access", "workspace-write"] as const)("admits the %s POSIX receipt through the public ExecService supervisor", async mode => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("empty"), { code: "ESRCH" }) })
  const { backend, exec } = setup(mode)
  const run = exec.run({ argv: [process.execPath, "fixture"], env: { MARKER: "exact" } })
  await vi.waitFor(() => expect(fixture.children).toHaveLength(1))
  fixture.children[0].stdout.write("owned-output")
  fixture.children[0].emit("exit", 0, null); endChild()
  expect(await run).toMatchObject({ stdout: "owned-output", exitCode: 0 })
  expect(fixture.argv[0]![0]).toBe(mode === "workspace-write" ? "bwrap" : process.execPath)
  expect((await backend.probe()).id).toBe("posix-local")
  await exec.dispose()
})
it.each(["complete-tree", "retain-tree"] as const)("honors %s after root exit while its owned group remains alive", async lifetime => {
  let groupAlive = true
  const signals: unknown[] = []
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-43210)
    if (signal === "SIGKILL") { signals.push(signal); groupAlive = false; endChild(); return true }
    if (!groupAlive) throw Object.assign(new Error("empty"), { code: "ESRCH" })
    return true
  })
  const { exec } = setup()
  const launched = await exec.launchTransport({ argv: [process.execPath], env: {}, transport: "pipe", lifetime, argumentEncoding: "crt" })
  const chunks: Buffer[] = []
  const drain = (async () => { for await (const frame of launched.handle.io.output) chunks.push(Buffer.from(frame.data)) })()
  fixture.children[0].stdout.write("before-root-exit")
  fixture.children[0].emit("exit", 0, null)
  if (lifetime === "complete-tree") {
    await vi.waitFor(() => expect(signals).toEqual(["SIGKILL"]), { timeout: 500 })
  } else {
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(signals).toEqual([])
    fixture.children[0].stdout.write("-descendant")
    groupAlive = false; endChild()
  }
  expect(await launched.handle.settled).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
  await drain
  expect(Buffer.concat(chunks).toString()).toBe(lifetime === "complete-tree" ? "before-root-exit" : "before-root-exit-descendant")
  await exec.dispose()
})
