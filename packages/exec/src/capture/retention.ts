import { OutputCollector } from "../spill.ts"
import type { ExecServiceOptions, ExecStreamRunOptions } from "../index.ts"
import type { Channel } from "./contracts.ts"

/** Captured bytes and spill finalization share one lifetime. */
export function createCaptureRetention(options: ExecServiceOptions, stream: ExecStreamRunOptions["stream"] | undefined) {
  const collected = options.spill && !stream ? {
    stdout: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stdout" }),
    stderr: new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000, maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: "stderr" }),
  } : undefined
  const raw: Record<Channel, Buffer[]> = { stdout: [], stderr: [] }
  let finalized = false
  const finalizeOutput = (): unknown[] => {
    if (finalized) return []
    finalized = true
    const failures: unknown[] = []
    if (collected) for (const collector of [collected.stdout, collected.stderr]) {
      try { collector.finalize() } catch (cause) { failures.push(cause) }
    }
    return failures
  }
  const output = () => ({
    stdout: collected?.stdout.snapshot() ?? { text: Buffer.concat(raw.stdout).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
    stderr: collected?.stderr.snapshot() ?? { text: Buffer.concat(raw.stderr).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
  })
  return { output, finalizeOutput,
    pushRaw(channel: Channel, bytes: Buffer) { raw[channel].push(bytes) },
    push(channel: Channel, bytes: Buffer) {
      if (!collected) raw[channel].push(bytes)
      collected?.[channel].push(bytes)
    },
  }
}
