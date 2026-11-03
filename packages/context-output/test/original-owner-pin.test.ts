import { expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createContextOutputService } from '../src/index.ts'

it('confirms only the original owner document under its authentic held scope after read revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'original-owner-pin-'))
  let held = true
  const service = createContextOutputService({ root, workspaceId: 'w', authorizeResult: async () => false })
  try {
    const scope = service.registerResultScope({ operationId: 'original', sessionId: 'parent', callId: 'call', documentId: 'task-parent', source: { sourceId: 'original-project' } }, () => held)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('original bytes'))
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected original committed bytes')
    await (service as any).confirmResultOwner?.(scope, result.ref)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const pins = await readdir(join(root, 'context-output', hash('w'), 'managed-v1', result.ref.id, 'pins'))
    expect(pins).toHaveLength(2)
    await expect(service.readResult({ sessionId: 'parent' }, { ref: result.ref })).rejects.toThrow(/unauthorized/)
    await expect((service as any).confirmResultOwner({ operationId: 'original' }, result.ref)).rejects.toThrow(/scope|source/)
    await expect((service as any).confirmResultOwner(scope, { ...result.ref, sessionId: 'foreign' })).rejects.toThrow(/reference|identity/)
    held = false
    await expect((service as any).confirmResultOwner(scope, result.ref)).rejects.toThrow(/source|closed/)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the first pin on a real second-pin quota refusal and cannot resurrect a confirmed deleted source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-pin-quota-delete-'))
  let deleted!: (documents: readonly string[]) => Promise<void>
  const service = createContextOutputService({ root, workspaceId: 'w', config: { maxDiskBytes: 2097152 }, documentDeletions: listener => { deleted = listener; return () => {} } })
  try {
    const scope = service.registerResultScope({ operationId: 'original', sessionId: 'parent', callId: 'call', documentId: 'task-parent' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    for (let remaining = 1_850_000; remaining > 0; remaining -= 65536) await sink.write(Buffer.alloc(Math.min(remaining, 65536), 120))
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected actual body below shared quota')
    await expect(service.confirmResultOwner(scope, result.ref)).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA' })
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const pins = join(root, 'context-output', hash('w'), 'managed-v1', result.ref.id, 'pins')
    expect(await readdir(pins)).toHaveLength(1)
    expect((await service.readResult({ sessionId: 'parent' }, { ref: result.ref, maxBytes: 1024 })).data.kind).toBe('text')
    await deleted(['parent'])
    await expect(service.confirmResultOwner(scope, result.ref)).rejects.toThrow(/deleted/)
    expect(await readdir(pins)).toHaveLength(1)
    await expect(service.readResult({ sessionId: 'parent' }, { ref: result.ref, maxBytes: 1024 })).rejects.toThrow(/deleted|unavailable/)
    await deleted(['task-parent'])
    await expect(service.confirmResultOwner(scope, result.ref)).rejects.toThrow(/deleted/)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
