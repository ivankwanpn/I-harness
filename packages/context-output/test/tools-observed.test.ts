import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createContextOutputService, createContextOutputTools, captureLegacyRefCommitment, type LegacyReadObservation } from '../src/index.ts'
it('actual legacy read and search tools enter observed methods with real retained data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-ot-'))
  const service = createContextOutputService({ root, workspaceId: 'workspace', requireObservedLegacyRecipients: true, config: { enabled: true } })
  try {
    const ref = await service.capture({ sessionId: 'source', callId: 'call', label: 'retained', text: 'VISIBLE actual tool data', complete: true, source: { sourceId: 'real-source', readonly: true } })
    if (!ref) throw new Error('Actual capture refused')
    const commitment = captureLegacyRefCommitment(ref)
    let active = true, calls = 0
    const observed: LegacyReadObservation = { sessionId: 'source', sourceId: 'real-source', assertCurrent() { if (!active) throw new Error('actual scope revoked') },
      localVisible: value => JSON.stringify(value) === JSON.stringify(commitment), anchorVisible: () => false }
    const read = vi.spyOn(service, 'read').mockRejectedValue(new Error('unobserved read trap'))
    const search = vi.spyOn(service, 'search').mockRejectedValue(new Error('unobserved search trap'))
    const tools = createContextOutputTools(service, { async withLegacyReadObservation(access, use) { expect(access.sessionId).toBe('source'); calls++; observed.assertCurrent(); const result = await use(observed); observed.assertCurrent(); return result } })
    expect(await tools.find(tool => tool.name === 'context_output_read')!.execute({ refId: ref.id }, { sessionId: 'source' } as any)).toMatchObject({ text: 'VISIBLE actual tool data' })
    expect(await tools.find(tool => tool.name === 'context_output_search')!.execute({ query: 'VISIBLE' }, { sessionId: 'source' } as any)).toMatchObject({ hits: [{ text: 'VISIBLE actual tool data' }] })
    expect(read).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(calls).toBe(2)
    active = false
    await expect(tools.find(tool => tool.name === 'context_output_search')!.execute({ query: 'VISIBLE' }, { sessionId: 'source' } as any)).rejects.toThrow('actual scope revoked')
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
