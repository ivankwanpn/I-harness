#!/usr/bin/env node
import { createInterface } from "node:readline"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { createBoundedWriter, DEFAULT_WRITE_BOUND_BYTES, decodeFrame, isRpcRequest } from "@i-harness/sdk"
import { createDesktopHost } from "./host.ts"

export async function main(args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "--session-dir" || !isAbsolute(args[1]!)) {
    console.error("usage: desktop-gateway --session-dir ABSOLUTE_DIR")
    return 1
  }

  const writer = createBoundedWriter({
    write: (chunk) => process.stdout.write(chunk),
    end: () => process.stdout.end(),
    onDrain: (callback) => {
      process.stdout.once("drain", callback)
      return () => { process.stdout.off("drain", callback) }
    },
    boundBytes: DEFAULT_WRITE_BOUND_BYTES,
  })

  let host: Awaited<ReturnType<typeof createDesktopHost>>
  try {
    host = await createDesktopHost({
      workspace: process.cwd(),
      sessionDir: args[1],
      onWrite: (frame) => writer.push(frame),
    })
  } catch (error) {
    console.error(`[desktop-gateway] startup failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  const active = new Set<Promise<void>>()
  let handshake: Promise<void> | undefined
  let closing: Promise<void> | undefined

  const close = (): Promise<void> => closing ??= (async () => {
    rl.close()
    await host.close()
    process.stdout.end()
  })()

  function track(work: Promise<void>): void {
    active.add(work)
    void work.catch((error) => {
      console.error(`[desktop-gateway] request failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { active.delete(work) })
  }

  rl.on("line", (line) => {
    const frame = decodeFrame(line)
    const method = isRpcRequest(frame) ? frame.method : undefined
    if (method === "initialize") {
      handshake = host.handleLine(line)
      track(handshake)
      return
    }
    const work = (handshake ?? Promise.resolve()).then(() => host.handleLine(line))
    track(work)
    if (method === "shutdown") void work.finally(() => close())
  })
  rl.on("close", () => { void close() })
  const onSignal = () => { void close() }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  await new Promise<void>((resolve) => rl.once("close", resolve))
  await close()
  await Promise.allSettled([...active])
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  return 0
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => {
    console.error(`[desktop-gateway] fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
