import { OutputCollector } from "../spill.ts"
import type { ExecServiceOptions, ExecStreamRunOptions } from "../index.ts"
import type { Channel } from "./contracts.ts"
import { CapturePreview } from './preview.ts'

/** Allocate the owner before constructing either fallible channel. */
export function createCaptureRetention(options: ExecServiceOptions, stream: ExecStreamRunOptions["stream"] | undefined,
  owner: ExecServiceOptions['resultRetention']) {
  const collected: Partial<Record<Channel, OutputCollector | CapturePreview>> = {}
  const raw: Record<Channel, Buffer[]> = { stdout: [], stderr: [] }
  const finalized = new Set<Channel>(), failures = new Map<Channel, unknown>()
  let initialized = false, previews = false
  return {
    initialize() {
      if (initialized) throw new Error('Capture retention already initialized')
      initialized = true
      previews = !!owner
      for (const channel of ['stdout', 'stderr'] as const) {
        if (owner) collected[channel] = new CapturePreview(owner.previewBytes ?? options.spill?.maxOutputBytes ?? 64000)
        else if (options.spill && !stream) collected[channel] = new OutputCollector({ maxBytes: options.spill.maxOutputBytes ?? 64_000,
          maxSpillBytes: options.spill.maxSpillBytes, spillRoot: options.spill.spillRoot, label: channel })
      }
    },
    finalizeOutput(): unknown[] {
      const newlyFailed: unknown[] = []
      for (const channel of ['stdout', 'stderr'] as const) {
        const collector = collected[channel]
        if (!collector || finalized.has(channel) || failures.has(channel)) continue
        try { collector.finalize(); finalized.add(channel) }
        // close may have taken effect before throwing. Never replay a stale fd.
        catch (cause) { failures.set(channel, cause); newlyFailed.push(cause) }
      }
      return newlyFailed
    },
    cleanupFailures: () => [...failures.values()],
    output: () => ({
      stdout: collected.stdout?.snapshot() ?? { text: Buffer.concat(raw.stdout).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
      stderr: collected.stderr?.snapshot() ?? { text: Buffer.concat(raw.stderr).toString("utf8"), truncated: false, spillPath: undefined, lossy: false },
    }),
    pushRaw(channel: Channel, bytes: Buffer) { if (previews) collected[channel]!.push(bytes); else raw[channel].push(bytes) },
    push(channel: Channel, bytes: Buffer) { if (collected[channel]) collected[channel]!.push(bytes); else raw[channel].push(bytes) },
  }
}
