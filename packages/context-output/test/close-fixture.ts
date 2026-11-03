import { open, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import type { ContextOutputService } from '../src/index.ts'

// Capture the actual handles from native writes; never replace a writer or
// service. Faults installed on these handles exercise original-owner cleanup.
export async function unfinishedResult(service: ContextOutputService, root: string, operationId: string) {
  const probe = await open(resolve(root, 'handle-probe'), 'w'), prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const bytes = Buffer.alloc(65536, 120), nativeWrite = prototype.write
  let body: FileHandle | undefined, leaves: FileHandle | undefined
  const spy = vi.spyOn(prototype, 'write').mockImplementation(async function(this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(nativeWrite, this, args)
    if (args[0] instanceof Uint8Array) {
      if (Buffer.from(args[0]).equals(bytes)) body = this
      else if (args[0].length === 32) leaves = this
    }
    return result
  })
  try {
    const scope = service.registerResultScope({ operationId, sessionId: 's', callId: operationId }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(bytes)
    if (!body || !leaves) throw new Error('Real writer handles were not observed')
    return { sink, body, leaves }
  } finally { spy.mockRestore() }
}
