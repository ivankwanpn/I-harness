import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { expect, it, vi } from "vitest"
import * as processTree from "../src/process-tree.ts"
import { createConnectedClient, mountMcpClient, type McpMountHandle, type McpServerConfig } from "../src/index.ts"
import { readMcpFailedConnectionCleanup } from "../src/client.ts"

const serverSource = `
import { createInterface } from 'node:readline'
const mode = process.argv[2]
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (mode === 'error' && request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, error:{ code:-32603, message:'fixture refused initialization' } }) + '\\n')
    return
  }
  const result = request.method === 'initialize'
    ? { protocolVersion:mode === 'version' ? '2099-01-01' : request.params.protocolVersion, capabilities:{ tools:{} }, serverInfo:{ name:'fixture', version:'1' } }
    : { tools:[] }
  process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, result }) + '\\n')
})
setTimeout(() => process.exit(0), 10000).unref()
`

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error }
}

it.each([
  ["error", /fixture refused initialization/],
  ["version", /protocol version is not supported: 2099-01-01/],
] as const)("keeps the same-name reservation through real stdio initialize %s cleanup", async (mode, expected) => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-initialize-cleanup-"))
  const script = join(root, "server.mjs")
  await writeFile(script, serverSource)
  const shutdownEntered = Promise.withResolvers<number>(), releaseShutdown = Promise.withResolvers<void>()
  const originalWindowsClose = processTree.killWindowsProcessTree
  const originalSdkClose = StdioClientTransport.prototype.close
  // Hold the exact Windows process-tree call before exit, or the SDK's
  // original stdio close on POSIX. The client/transport and server stay real.
  const close = process.platform === "win32"
    ? vi.spyOn(processTree, "killWindowsProcessTree").mockImplementation(async pid => {
      shutdownEntered.resolve(pid)
      await releaseShutdown.promise
      await originalWindowsClose(pid)
    })
    : vi.spyOn(StdioClientTransport.prototype, "close").mockImplementation(async function (this: StdioClientTransport) {
      shutdownEntered.resolve(this.pid!)
      await releaseShutdown.promise
      await originalSdkClose.call(this)
    })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const config: McpServerConfig = { transport: "stdio", serverName: "initialize", command: process.execPath,
    args: [script, mode], cwd: root }
  let finished = false, successor: McpMountHandle | undefined
  const starting = mountMcpClient(ctx, tools, config)
  const settled = starting.then(() => undefined, error => error).finally(() => { finished = true })
  try {
    const pid = await shutdownEntered.promise
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(isAlive(pid)).toBe(true)
    await setImmediate()
    expect(finished).toBe(false)
    const connect = vi.fn(async () => { throw Error("must not start the replacement yet") })
    await expect(mountMcpClient(ctx, tools, config, { connect })).rejects.toThrow(/already reserved/)
    expect(connect).not.toHaveBeenCalled()
    releaseShutdown.resolve()
    expect(await settled).toBeInstanceOf(Error)
    expect(String(await settled)).toMatch(expected)
    expect(isAlive(pid)).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
    successor = await mountMcpClient(ctx, tools, { ...config, args: [script, "ok"] })
  } finally {
    releaseShutdown.resolve()
    await settled
    await successor?.unmount()
    close.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it("transfers only the failed connector's original stdio cleanup for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-initialize-retry-"))
  const script = join(root, "server.mjs")
  await writeFile(script, serverSource)
  const originalClose = StdioClientTransport.prototype.close
  const tree = process.platform === "win32" ? vi.spyOn(processTree, "killWindowsProcessTree").mockResolvedValue(undefined) : undefined
  let originalTransport: StdioClientTransport | undefined
  const failure = new Error("fixture did not confirm original stdio close")
  const close = vi.spyOn(StdioClientTransport.prototype, "close").mockImplementationOnce(async function (this: StdioClientTransport) {
    originalTransport = this
    throw failure
  })
  let retry: (() => Promise<void>) | undefined
  try {
    const error: unknown = await createConnectedClient({ transport: "stdio", serverName: "initialize",
      command: process.execPath, args: [script, "error"], cwd: root }).catch(reason => reason)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[1]).toBe(failure)
    expect(readMcpFailedConnectionCleanup({ ...(error as object) })).toBeUndefined()
    retry = readMcpFailedConnectionCleanup(error)
    expect(retry).toBeTypeOf("function")
    const pid = originalTransport!.pid!
    expect(isAlive(pid)).toBe(true)
    await retry!()
    expect(isAlive(pid)).toBe(false)
    expect(close).toHaveBeenCalledTimes(2)
    expect(tree?.mock.calls.length ?? 0).toBe(process.platform === "win32" ? 1 : 0)
  } finally {
    try { if (retry) await retry(); else if (originalTransport) await originalClose.call(originalTransport) }
    finally {
      close.mockRestore()
      tree?.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
})
